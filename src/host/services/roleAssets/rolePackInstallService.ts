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
import { BUILTIN_ROLES, validateBuiltinRolePack, type BuiltinRoleDefinition } from './builtinRoles';
import { ensureRoleAssetDirs } from './roleAssetService';
import { getRolePackRegistryService } from './rolePackRegistryService';
import { parseAgentMd } from '../../agent/hybrid/agentMdLoader';

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
}

type InstalledRolePacksFile = Record<string, InstalledRolePackRecord>;

export interface RolePackActionResult {
  success: boolean;
  roleId: string;
  installState?: RolePackInstallState;
  missingSkills?: string[];
  locallyModified?: boolean;
  reason?: string;
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

export async function getInstalledRolePackState(roleId: string): Promise<{ locallyModified: boolean } | null> {
  const record = (await loadRecords())[roleId];
  if (!record) return null;
  const currentHash = await readAgentHash(roleId);
  return { locallyModified: currentHash !== null && currentHash !== record.installedAgentMdHash };
}

/** 还原云包时只取经签名 registry 验证过的原始 agentMd；拿不到就明确失败。 */
export async function getRolePackFactoryDefinition(roleId: string): Promise<{ agentMd: string } | null> {
  if (!(await loadRecords())[roleId]) return null;
  const entry = await getRolePackRegistryService().getEntry(roleId);
  return entry ? { agentMd: entry.agentMd } : null;
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
): Promise<RolePackActionResult> {
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
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await fs.writeFile(agentPath, entry.agentMd, 'utf8');
    installedAgentMdHash = hash(entry.agentMd);
  } else {
    locallyModified = true;
  }

  const installState: RolePackInstallState = missingSkills.length > 0 ? 'degraded' : 'complete';
  records[entry.roleId] = {
    packVersion: entry.packVersion,
    installedAgentMdHash,
    installState,
    missingSkills,
    installedSkills: [...new Set([...preserved.registryNames, ...installedSkills])],
    installedAt: new Date().toISOString(),
    publisher: entry.publisher,
    ...(locallyModified ? { locallyModified: true } : {}),
  };
  await ensureRoleAssetDirs(entry.roleId);
  await saveRecords(records);
  return { success: true, roleId: entry.roleId, installState, missingSkills, locallyModified };
}

/** Install or upgrade by roleId only; never trust a renderer-provided entry body. */
export async function installRolePack(roleId: string): Promise<RolePackActionResult> {
  if (BUILTIN_ROLES.some((role) => role.id === roleId)) {
    return { success: false, roleId, reason: '编译内内置角色 id 优先，拒绝云端角色包覆盖' };
  }
  const entry = await getRolePackRegistryService().getEntry(roleId);
  if (!entry) return { success: false, roleId, reason: '未找到角色包 registry 条目' };
  const records = await loadRecords();
  return installEntry(entry, records[roleId]);
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
