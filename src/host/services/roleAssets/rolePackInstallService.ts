// ============================================================================
// Cloud role pack installation — definition is L0, role assets are user-owned L1
// ============================================================================

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir, getAgentsMdDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';
import { getRemoteSkillRegistryService } from '../../skills/marketplace/remoteSkillRegistryService';
import { installFromRegistryEntry, uninstallPlugin } from '../../skills/marketplace/installService';
import { SKILL_REGISTRY_MARKETPLACE_ID } from '../../../shared/contract/skillRegistry';
import type { RolePackEntry } from '../../../shared/contract/rolePackRegistry';
import type { ExpertConnector } from '../../../shared/contract/expertConnectors';
import { BUILTIN_ROLES, validateBuiltinRolePack, type BuiltinRoleDefinition } from './builtinRoles';
import { ensureRoleAssetDirs } from './roleAssetService';
import { getRolePackRegistryService } from './rolePackRegistryService';
import { parseAgentMd, updateAgentMdEquipment, updateAgentMdVisual } from '../../agent/hybrid/agentMdLoader';

const logger = createLogger('RolePackInstallService');
const ROLE_PACKS_FILE = 'role-packs.json';
async function getBuiltinSkillNames(): Promise<Set<string>> {
  // Keep the large built-in skill data graph off the normal roles IPC load path.
  // This is deliberately the compiled role-pack skill list, never the user's machine.
  const { BUILTIN_SKILLS } = await import('../../services/skills/builtinSkillsData');
  return new Set(BUILTIN_SKILLS.map((skill) => skill.name));
}

type RolePackInstallState = 'complete' | 'degraded';

interface InstalledRolePackRecord {
  packVersion: string;
  installedAgentMdHash: string;
  installState: RolePackInstallState;
  missingSkills: string[];
  installedSkills: string[];
  installedAt: string;
  publisher: string;
  locallyModified?: boolean;
  /** 用户装包时选了「按包声明装」（接受了提权）；还原出厂据此决定要不要再剥一次。 */
  elevationAccepted?: boolean;
  /**
   * 刚装上、还没跑过第一轮。第一轮强制 strict 档，不看包自己声明的档位——
   * 第三方 prompt 就是注入面，先让用户在最严档下看它一轮怎么干活。
   */
  firstRunPending?: boolean;
}

type InstalledRolePacksFile = Record<string, InstalledRolePackRecord>;

export interface RolePackActionResult {
  success: boolean;
  roleId: string;
  installState?: RolePackInstallState;
  missingSkills?: string[];
  locallyModified?: boolean;
  reason?: string;
  /**
   * 用户尚未过目这个包能干什么；renderer 据此弹确认卡，**不当作失败**。
   * 强确认（2026-07-25 产品负责人拍板）：不只提权包，**每个包**装之前都要过这一关——
   * 装之前用户根本不知道它能读文件、能发飞书、要连哪个连接器。
   */
  consent?: RolePackConsent;
}

export interface RolePackListItem {
  entry: RolePackEntry;
  /** Agent frontmatter parsed on the trusted host; renderer never parses YAML. */
  tools: string[];
  installed: boolean;
  installState?: RolePackInstallState;
  missingSkills?: string[];
  locallyModified?: boolean;
  hasUpdate: boolean;
}

/**
 * 首跑强制 strict 的判据，consume-on-use：返回 true 表示这一轮要按 strict 跑，并立刻清位。
 *
 * ponytail: 在"开始跑"而不是"跑完"清位——第一轮中途崩掉会白白用掉这次强制档。
 * 取舍理由：跑完才清需要贯穿整条执行链传递清位时机，而这一档的价值是"用户第一次见它干活时
 * 别让它放手"，崩掉的那次本来也没干成什么。
 */
export async function consumeFirstRunStrict(roleId: string): Promise<boolean> {
  const records = await loadRecords();
  const record = records[roleId];
  if (!record?.firstRunPending) return false;
  records[roleId] = { ...record, firstRunPending: false };
  await saveRecords(records);
  return true;
}

export async function getInstalledRolePackState(roleId: string): Promise<{ locallyModified: boolean } | null> {
  const record = (await loadRecords())[roleId];
  if (!record) return null;
  const currentHash = await readAgentHash(roleId);
  return { locallyModified: currentHash !== null && currentHash !== record.installedAgentMdHash };
}

function agentMdWithVisual(entry: RolePackEntry): string {
  return updateAgentMdVisual(entry.agentMd, entry.visual);
}

/** frontmatter 是否**显式**声明了 tools（省略 tools 会走 parseAgentMd 的默认 6 件集，含 Bash 但那是基线不是声明）。 */
function declaresToolsExplicitly(agentMd: string): boolean {
  const frontmatter = agentMd.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  return /^tools:/m.test(frontmatter);
}

/**
 * 云包提权检测。两条真提权：放手档（ci）、**显式声明** Bash（影响范围无法预估）。
 * 关键：没声明 tools 的包会继承默认工具集（本就含 Bash），那是每个内置角色的基线，不算提权——
 * 只有包主动把 Bash 写进 tools 才算。Write/Edit/联网不算：标准档下它们受工作目录与审批闸约束。
 */
/**
 * 装包前给用户的人话摘要三源：声明的工具、声明的连接器、权限档。
 * 三源全部来自 agent.md frontmatter，不新造元数据（#671 的 connectors + #637 的 permission-override）。
 */
interface RolePackConsent {
  /** 实际会生效的工具集（显式声明则用声明，否则是内置基线）。 */
  tools: string[];
  /** 是否显式声明了 tools——没声明就是继承基线，摘要里要说清楚这点，别让用户以为是包主动要的。 */
  toolsDeclared: boolean;
  /** #671 声明的推荐连接器（core 默认开 / optional 默认关）。 */
  connectors: ExpertConnector[];
  /** #637 的 per-role 权限档；缺省表示跟随通用设置。 */
  permissionPreset?: 'strict' | 'development' | 'ci';
  /** 命中提权判据时非空——UI 据此加重告警，普通包只是平铺摘要。 */
  elevation: { looseMode: boolean; bashTool: boolean } | null;
}

function buildRolePackConsent(agentMd: string, roleId: string): RolePackConsent {
  const parsed = parseAgentMd(agentMd, `${roleId}.md`);
  return {
    tools: parsed?.tools ?? [],
    toolsDeclared: declaresToolsExplicitly(agentMd),
    connectors: parsed?.connectors ?? [],
    ...(parsed?.permissionPreset ? { permissionPreset: parsed.permissionPreset } : {}),
    elevation: detectRolePackElevation(agentMd, roleId),
  };
}

export function detectRolePackElevation(
  agentMd: string,
  roleId: string,
): { looseMode: boolean; bashTool: boolean } | null {
  const parsed = parseAgentMd(agentMd, `${roleId}.md`);
  if (!parsed) return null;
  const looseMode = parsed.permissionPreset === 'ci';
  const bashTool = declaresToolsExplicitly(agentMd) && parsed.tools.includes('Bash');
  return looseMode || bashTool ? { looseMode, bashTool } : null;
}

/**
 * 把提权项降回安全默认：档位回到跟随通用设置；只有**显式声明** Bash 时才从声明里剔除它
 * （没声明 tools 的包不改 tools，免得把基线里默认给的 Bash 也悄悄拿掉）。其它字段与正文原样保留。
 */
export function stripRolePackElevation(agentMd: string, roleId: string): string {
  const parsed = parseAgentMd(agentMd, `${roleId}.md`);
  if (!parsed) return agentMd;
  const toolsDeclared = declaresToolsExplicitly(agentMd);
  return updateAgentMdEquipment(agentMd, {
    skills: parsed.skills ?? [],
    tools: toolsDeclared ? parsed.tools.filter((tool) => tool !== 'Bash') : parsed.tools,
    model: parsed.model,
    modelOverride: parsed.modelOverride ?? null,
    maxIterations: parsed.maxIterations,
    permissionPreset: null,
  });
}

/** 还原云包时只取经签名 registry 验证过的原始 agentMd；拿不到就明确失败。 */
export async function getRolePackFactoryDefinition(roleId: string): Promise<{ agentMd: string } | null> {
  const record = (await loadRecords())[roleId];
  if (!record) return null;
  const entry = await getRolePackRegistryService().getEntry(roleId);
  if (!entry) return null;
  const raw = agentMdWithVisual(entry);
  // 当初装的是剥后版本，还原也必须还原到剥后版本，否则一还原又提权。
  return { agentMd: record.elevationAccepted ? raw : stripRolePackElevation(raw, roleId) };
}

function rolePacksPath(): string {
  return path.join(getUserConfigDir(), ROLE_PACKS_FILE);
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function loadRecords(): Promise<InstalledRolePacksFile> {
  try {
    return JSON.parse(await fs.readFile(rolePacksPath(), 'utf8')) as InstalledRolePacksFile;
  } catch {
    return {};
  }
}

async function saveRecords(records: InstalledRolePacksFile): Promise<void> {
  const filePath = rolePacksPath();
  const tempPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function toDefinition(entry: RolePackEntry): BuiltinRoleDefinition {
  return { id: entry.roleId, agentMd: entry.agentMd, visual: entry.visual };
}

function bottomLineReasons(
  issues: ReturnType<typeof validateBuiltinRolePack>,
  successfulSkills: number,
): string[] {
  const reasons = issues
    .filter((item) => item.code !== 'unresolvable-skill')
    .map((item) => item.issue);
  if (successfulSkills === 0) reasons.push('声明的 skill 均未安装成功');
  return reasons;
}

async function readAgentHash(roleId: string): Promise<string | null> {
  try {
    return hash(await fs.readFile(path.join(getAgentsMdDir().user, `${roleId}.md`), 'utf8'));
  } catch {
    return null;
  }
}

async function installEntry(
  entry: RolePackEntry,
  existing?: InstalledRolePackRecord,
  preserved: { registryNames: string[]; skillNames: Iterable<string> } = { registryNames: [], skillNames: [] },
  options?: { acceptElevation?: boolean; elevationReviewed?: boolean },
): Promise<RolePackActionResult> {
  // 强确认闸门必须在**任何副作用之前**。2026-07-25 真机 dogfood 抓到：闸门原本排在
  // 技能安装循环之后，于是点安装 → 卡还没弹，技能已经在下载落盘；点取消只取消了角色登记，
  // 插件已经装进机器 = 半安装状态。所以先问，再动手。
  const consentPrevious = existing ?? (await loadRecords())[entry.roleId];
  const reviewed = options?.acceptElevation === true
    || options?.elevationReviewed === true
    || consentPrevious !== undefined;
  if (!reviewed) {
    return {
      success: false,
      roleId: entry.roleId,
      consent: buildRolePackConsent(agentMdWithVisual(entry), entry.roleId),
    };
  }

  const installedSkills: string[] = [];
  const missingSkills: string[] = [];
  const installedSkillNames = new Set<string>();

  for (const skillRef of entry.skills) {
    const skillEntry = await getRemoteSkillRegistryService().getEntry(skillRef.registryName);
    if (!skillEntry) {
      missingSkills.push(skillRef.registryName);
      continue;
    }
    try {
      const result = await installFromRegistryEntry(skillEntry, { force: true, enableAfterInstall: true });
      if (result.installedSkills.length === 0) {
        missingSkills.push(skillRef.registryName);
        continue;
      }
      installedSkills.push(skillRef.registryName);
      result.installedSkills.forEach((name) => installedSkillNames.add(name));
    } catch (error) {
      logger.warn('Role pack skill install failed', { roleId: entry.roleId, skill: skillRef.registryName, error: String(error) });
      missingSkills.push(skillRef.registryName);
    }
  }

  // ADR-048 §5: compiled skills plus skills this pack actually installed. Do not
  // include arbitrary locally-installed skills; that would make the pack non-portable.
  const knownSkillNames = new Set([
    ...(await getBuiltinSkillNames()),
    ...preserved.skillNames,
    ...installedSkillNames,
  ]);
  const issues = validateBuiltinRolePack(toDefinition(entry), knownSkillNames);
  const reasons = bottomLineReasons(issues, installedSkills.length);
  if (reasons.length > 0) {
    await Promise.all(installedSkills.map(async (name) => {
      await uninstallPlugin(`${name}@${SKILL_REGISTRY_MARKETPLACE_ID}`, { scope: 'user' }).catch(() => {});
    }));
    return { success: false, roleId: entry.roleId, reason: reasons.join('；') };
  }

  const records = await loadRecords();
  const previous = existing ?? records[entry.roleId];
  const agentPath = path.join(getAgentsMdDir().user, `${entry.roleId}.md`);
  const currentHash = await readAgentHash(entry.roleId);
  let installedAgentMdHash = previous?.installedAgentMdHash ?? '';
  let locallyModified = false;
  if (!currentHash || previous?.installedAgentMdHash === currentHash) {
    const raw = agentMdWithVisual(entry);
    // 已过目 = 用户在确认卡上做过选择（按安全默认装 / 按声明装），或这是对已装包的升级/重试。
    const reviewed = options?.acceptElevation === true
      || options?.elevationReviewed === true
      || previous !== undefined;
    if (!reviewed) {
      // 强确认：不落任何盘，先把「这个专家能干什么」交给 renderer 弹卡。
      // 此前只有提权包才拦，普通包静默装——用户装完也不知道它能读文件、要连哪个连接器。
      return { success: false, roleId: entry.roleId, consent: buildRolePackConsent(raw, entry.roleId) };
    }
    // 保留提权项的两种情形：本次显式「按声明装」，或上次装时已接受过（升级/重试不该悄悄剥回）。
    const keepElevation = options?.acceptElevation === true || previous?.elevationAccepted === true;
    const content = keepElevation ? raw : stripRolePackElevation(raw, entry.roleId);
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, content, 'utf8');
    installedAgentMdHash = hash(content);
  } else {
    locallyModified = true;
  }

  const installState: RolePackInstallState = missingSkills.length > 0 ? 'degraded' : 'complete';
  // 全新安装才置位；升级/重试不重置（那不是"第一次见到这个专家"）。
  const firstRunPending = previous === undefined ? { firstRunPending: true } : {};
  records[entry.roleId] = {
    ...firstRunPending,
    packVersion: entry.packVersion,
    installedAgentMdHash,
    installState,
    missingSkills,
    installedSkills: [...new Set([...preserved.registryNames, ...installedSkills])],
    installedAt: new Date().toISOString(),
    publisher: entry.publisher,
    ...(locallyModified ? { locallyModified: true } : {}),
    // 本次按声明装则记 true；升级/重试沿用上次的选择；选安全默认则清掉。
    ...((options?.acceptElevation === true || (options?.acceptElevation === undefined && previous?.elevationAccepted === true)) ? { elevationAccepted: true } : {}),
  };
  await ensureRoleAssetDirs(entry.roleId);
  await saveRecords(records);
  return { success: true, roleId: entry.roleId, installState, missingSkills, locallyModified };
}

/** Install or upgrade by roleId only; never trust a renderer-provided entry body. */
export async function installRolePack(
  roleId: string,
  options?: { acceptElevation?: boolean; elevationReviewed?: boolean },
): Promise<RolePackActionResult> {
  if (BUILTIN_ROLES.some((role) => role.id === roleId)) {
    return { success: false, roleId, reason: '编译内内置角色 id 优先，拒绝云端角色包覆盖' };
  }
  const entry = await getRolePackRegistryService().getEntry(roleId);
  if (!entry) return { success: false, roleId, reason: '未找到角色包 registry 条目' };
  const records = await loadRecords();
  return installEntry(entry, records[roleId], undefined, options);
}

/** Retry only the missing registry entries recorded for a degraded installed pack. */
export async function retryMissingSkills(roleId: string): Promise<RolePackActionResult> {
  const records = await loadRecords();
  const record = records[roleId];
  if (!record) return { success: false, roleId, reason: '角色包未安装' };
  if (record.missingSkills.length === 0) return { success: true, roleId, installState: record.installState, missingSkills: [] };
  const entry = await getRolePackRegistryService().getEntry(roleId);
  if (!entry) return { success: false, roleId, reason: '未找到角色包 registry 条目' };
  const installedEntries = await Promise.all(
    record.installedSkills.map((name) => getRemoteSkillRegistryService().getEntry(name)),
  );
  const preservedSkillNames = installedEntries.flatMap((item) => item?.skills ?? []);
  return installEntry(
    { ...entry, skills: entry.skills.filter((skill) => record.missingSkills.includes(skill.registryName)) },
    record,
    { registryNames: record.installedSkills, skillNames: preservedSkillNames },
    // 重试是对已安装包的操作，不该再弹提权确认；是否保留提权由 record.elevationAccepted 决定。
    { elevationReviewed: true },
  );
}

export async function uninstallRolePack(roleId: string): Promise<RolePackActionResult> {
  const records = await loadRecords();
  const record = records[roleId];
  if (!record) return { success: false, roleId, reason: '角色包未安装' };
  const sharedSkills = new Set(
    Object.entries(records)
      .filter(([id]) => id !== roleId)
      .flatMap(([, other]) => other.installedSkills),
  );
  for (const skillName of record.installedSkills) {
    if (!sharedSkills.has(skillName)) {
      await uninstallPlugin(`${skillName}@${SKILL_REGISTRY_MARKETPLACE_ID}`, { scope: 'user' });
    }
  }
  const agentPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  const currentHash = await readAgentHash(roleId);
  const locallyModified = currentHash !== null && currentHash !== record.installedAgentMdHash;
  if (!locallyModified) await fs.rm(agentPath, { force: true });
  // Deliberately never remove roles/<roleId>: memory, history and bindings belong to the user.
  delete records[roleId];
  await saveRecords(records);
  return { success: true, roleId, locallyModified };
}

/** Registry shelf crossed with local installation state. */
export async function listRolePacks(): Promise<RolePackListItem[]> {
  const entries = await getRolePackRegistryService().fetchEntries().then((result) => result.entries);
  const records = await loadRecords();
  return entries.map((entry) => {
    const record = records[entry.roleId];
    return {
      entry,
      tools: parseAgentMd(entry.agentMd, `${entry.roleId}.md`)?.tools ?? [],
      installed: Boolean(record),
      ...(record ? {
        installState: record.installState,
        missingSkills: record.missingSkills,
        locallyModified: record.locallyModified,
      } : {}),
      hasUpdate: Boolean(record) && record.packVersion !== entry.packVersion,
    };
  });
}
