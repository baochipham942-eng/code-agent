// ============================================================================
// RoleDraftQueue — 对话式建角色的草稿确认队列（role-creation-flow）
//
// 模型在"建角色"会话里通过 propose_role 工具起草角色定义，落到
// ~/.code-agent/role-drafts/<id>/（与 roles/ 平级，不会被 agentRegistry 扫描）。
// 严禁自动入库：只有用户通过 IPC 确认后才写入 agents/<roleId>.md + 建 roles/<roleId>/。
//
// 镜像 services/skills/skillDraftQueue.ts 的范式（草稿 → 聊天卡确认 → 落盘）。
// 与 skill 草稿不同：角色创建是用户主动发起（非 telemetry 蒸馏），
// 故不需要 accepted/rejected ledger，去重只看 roleId（同名 agent / 待确认草稿）。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir, getAgentsMdDir } from '../../config/configPaths';
import { ROLE_ASSETS } from '../../../shared/constants';
import type { SkillCategory } from '../../../shared/contract/skillRepository';
import { scanSkillContent } from '../../security/skillContentGuard';
import { createLogger } from '../infra/logger';
import { isSafeRoleId } from './roleAssetPaths';
import { ensureRoleAssetDirs, isPersistentRole } from './roleAssetService';

const logger = createLogger('RoleDraftQueue');

const DRAFT_META_FILENAME = 'draft.json';
const DRAFT_AGENT_FILENAME = 'agent.md';

/** 角色草稿来源：对话式起草（本期唯一来源） */
export type RoleDraftOrigin = 'conversational';

export interface RoleDraftMeta {
  /** 草稿目录名（队列内唯一，slug+时间戳，仅用于定位草稿，确认后丢弃） */
  id: string;
  /** 角色 ID = 确认后 agents/<roleId>.md 文件名 = roles/<roleId>/ 目录名（允许中文） */
  roleId: string;
  /** 角色一句话描述（agent frontmatter description） */
  description: string;
  /** 产物分类（复用 SkillCategory 体系，前端 icon/分组用） */
  category?: SkillCategory;
  /** 工具白名单（agent frontmatter tools；空数组 = 用默认全集） */
  tools: string[];
  /** 系统提示词（agent 定义正文） */
  systemPrompt: string;
  /** 草稿来源 */
  origin: RoleDraftOrigin;
  /** 起草会话 id */
  sessionId: string;
  createdAt: number;
  status: 'pending';
  /** 预留：对话式改已有角色时记录被编辑的 roleId（本期恒为 undefined） */
  editingRoleId?: string;
}

export function getRoleDraftsDir(): string {
  return path.join(getUserConfigDir(), ROLE_ASSETS.DRAFTS_DIR_NAME);
}

// ----------------------------------------------------------------------------
// 草稿生成
// ----------------------------------------------------------------------------

function sanitizeDraftId(roleId: string, timestamp: number): string {
  // roleId 可能是中文，slug 化后可能为空，用 'role' 兜底；草稿目录名只需文件系统安全
  const safe = roleId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${safe || 'role'}-${timestamp}`;
}

/** 单行化 + 去引号，避免破坏 YAML frontmatter */
function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

/**
 * 生成角色 agent 定义（agents/<roleId>.md 内容），格式对齐 builtinRoles。
 */
export function generateRoleAgentMd(input: {
  roleId: string;
  description: string;
  tools: string[];
  systemPrompt: string;
}): string {
  const fm: string[] = [
    '---',
    `name: ${sanitizeFrontmatterValue(input.roleId)}`,
    `description: ${sanitizeFrontmatterValue(input.description)}`,
  ];
  if (input.tools.length > 0) {
    fm.push(`tools: [${input.tools.join(', ')}]`);
  }
  fm.push('model: balanced');
  fm.push('max-iterations: 20');
  fm.push('---');

  return `${fm.join('\n')}\n\n${input.systemPrompt.trim()}\n`;
}

// ----------------------------------------------------------------------------
// 队列操作
// ----------------------------------------------------------------------------

/** 列出待确认的角色草稿（按创建时间倒序）。 */
export async function listRoleDrafts(): Promise<RoleDraftMeta[]> {
  const dir = getRoleDraftsDir();
  const drafts: RoleDraftMeta[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const metaPath = path.join(dir, entry, DRAFT_META_FILENAME);
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      drafts.push(JSON.parse(raw) as RoleDraftMeta);
    } catch {
      // 不是草稿目录，跳过
    }
  }

  return drafts.sort((a, b) => b.createdAt - a.createdAt);
}

export interface EnqueueRoleDraftResult {
  draft: RoleDraftMeta | null;
  /** draft 为 null 时给出原因（透传给模型，便于换名重试） */
  reason?: string;
}

/**
 * 把模型起草的角色定义入队为草稿。
 *
 * 两种模式：
 * - 新建（editingRoleId 缺省）：拒绝同名持久化角色（不能造重名）。
 * - 改已有（editingRoleId 有值）：跳过同名去重（改已有就是要同名），改为校验
 *   editingRoleId 对应角色真实存在；本期不支持改名，editingRoleId !== roleId 直接拒。
 *
 * 拒绝入队（draft=null）的情况：roleId 非法 / 缺 systemPrompt /
 * （新建）已存在同名持久化角色 /（改已有）目标角色不存在 / 改名 /
 * 队列里已有同名待确认草稿。
 */
export async function enqueueRoleDraft(input: {
  roleId: string;
  description: string;
  category?: SkillCategory;
  tools?: string[];
  systemPrompt: string;
  sessionId: string;
  timestamp?: number;
  /** 有值 = 对话式改已有角色（覆盖该角色定义，绝不动其记忆/履历） */
  editingRoleId?: string;
}): Promise<EnqueueRoleDraftResult> {
  const createdAt = input.timestamp ?? Date.now();
  const roleId = input.roleId?.trim();
  const editingRoleId = input.editingRoleId?.trim() || undefined;

  if (!roleId || !isSafeRoleId(roleId)) {
    logger.warn('Role draft rejected: invalid roleId', { roleId: input.roleId });
    return { draft: null, reason: `角色名非法（不能含 / \\ 等路径字符）："${input.roleId}"` };
  }
  if (!input.systemPrompt || !input.systemPrompt.trim()) {
    return { draft: null, reason: '缺少系统提示词（systemPrompt）' };
  }

  if (editingRoleId) {
    // 改已有：本期只改内容不改名
    if (editingRoleId !== roleId) {
      return {
        draft: null,
        reason: `暂不支持改名（从「${editingRoleId}」改为「${roleId}」），本期只能改内容`,
      };
    }
    // 目标角色必须真实存在
    if (!(await isPersistentRole(editingRoleId))) {
      return { draft: null, reason: `要修改的角色「${editingRoleId}」不存在` };
    }
  } else if (await isPersistentRole(roleId)) {
    // 新建：已存在同名持久化角色 → 拒绝
    return { draft: null, reason: `已存在同名角色「${roleId}」，请换一个名字` };
  }

  // 队列里已有同名待确认草稿 → 拒绝（迭代时让用户先确认/放弃旧草稿）
  const existing = await listRoleDrafts();
  if (existing.some((d) => d.roleId === roleId)) {
    return { draft: null, reason: `已有一个待确认的「${roleId}」草稿，请先确认或放弃它` };
  }

  const id = sanitizeDraftId(roleId, createdAt);
  const draftDir = path.join(getRoleDraftsDir(), id);
  await fs.mkdir(draftDir, { recursive: true });

  const tools = input.tools ?? [];
  const meta: RoleDraftMeta = {
    id,
    roleId,
    description: input.description ?? '',
    category: input.category,
    tools,
    systemPrompt: input.systemPrompt,
    origin: 'conversational',
    sessionId: input.sessionId,
    createdAt,
    status: 'pending',
    editingRoleId,
  };

  const agentMd = generateRoleAgentMd({
    roleId,
    description: meta.description,
    tools,
    systemPrompt: input.systemPrompt,
  });

  await fs.writeFile(path.join(draftDir, DRAFT_AGENT_FILENAME), agentMd, 'utf-8');
  await fs.writeFile(path.join(draftDir, DRAFT_META_FILENAME), JSON.stringify(meta, null, 2), 'utf-8');

  logger.info('Role draft enqueued (pending user confirmation)', { id, roleId });
  return { draft: meta };
}

/**
 * 用户确认草稿：把 agent.md 写入 ~/.code-agent/agents/<roleId>.md + 建 roles/<roleId>/ 骨架。
 * agentRegistry 的 chokidar watcher 会自动捡到新文件并广播 agents:changed。
 */
export async function confirmRoleDraft(
  id: string,
): Promise<{ success: boolean; roleId?: string; agentMdPath?: string; error?: string }> {
  const draftDir = path.join(getRoleDraftsDir(), path.basename(id));
  const metaPath = path.join(draftDir, DRAFT_META_FILENAME);

  let meta: RoleDraftMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as RoleDraftMeta;
  } catch {
    return { success: false, error: `草稿不存在：${id}` };
  }

  if (!isSafeRoleId(meta.roleId)) {
    return { success: false, error: `草稿角色名非法：${meta.roleId}` };
  }

  try {
    const agentMd = await fs.readFile(path.join(draftDir, DRAFT_AGENT_FILENAME), 'utf-8');

    // fail-closed 安全闸：落盘前过内容扫描，命中危险命令 / 明文密钥则拒绝。
    // 草稿留在队列，用户可查看后放弃（与 skillDraftQueue 同策略）。
    const guard = scanSkillContent(agentMd);
    if (guard.verdict === 'block') {
      logger.warn('Role draft blocked by content guard', {
        id,
        findings: guard.findings.map((f) => f.kind),
      });
      return {
        success: false,
        error: `安全扫描未通过，已拒绝入库：${guard.findings.map((f) => f.detail).join('；')}`,
      };
    }

    const isEdit = Boolean(meta.editingRoleId);
    // 改已有时本期只改内容不改名（防御性二次校验：草稿被外部篡改也兜得住）
    if (isEdit && meta.editingRoleId !== meta.roleId) {
      return {
        success: false,
        error: `暂不支持改名（从「${meta.editingRoleId}」改为「${meta.roleId}」），本期只能改内容`,
      };
    }

    const agentMdPath = path.join(getAgentsMdDir().user, `${meta.roleId}.md`);
    const alreadyExists = await fs.access(agentMdPath).then(() => true, () => false);
    // 新建：不覆盖已有定义（与 installBuiltinRoles 同策略："定义归用户所有"）。
    // 改已有：允许覆盖定义——这正是用户要的；但只换 agents/<id>.md，绝不动 roles/<id>/ 记忆与履历。
    if (alreadyExists && !isEdit) {
      return { success: false, error: `已存在同名角色定义「${meta.roleId}」，未覆盖` };
    }

    await fs.mkdir(path.dirname(agentMdPath), { recursive: true });
    await fs.writeFile(agentMdPath, agentMd, 'utf-8');
    // 角色资产骨架（roles/<roleId>/ MEMORY.md + memories/ + history.md），幂等。
    // 改已有时这是 no-op（目录与索引已存在），不会重置用户积累的记忆/履历。
    await ensureRoleAssetDirs(meta.roleId);
    await fs.rm(draftDir, { recursive: true, force: true });

    logger.info('Role draft confirmed and installed', { id, roleId: meta.roleId, isEdit, agentMdPath });
    return { success: true, roleId: meta.roleId, agentMdPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to confirm role draft', { id, error: message });
    return { success: false, error: message };
  }
}

/** 用户放弃草稿：删除草稿目录（角色创建是主动发起，无需记 rejected ledger）。 */
export async function rejectRoleDraft(id: string): Promise<{ success: boolean; error?: string }> {
  const draftDir = path.join(getRoleDraftsDir(), path.basename(id));
  const metaPath = path.join(draftDir, DRAFT_META_FILENAME);

  try {
    await fs.access(metaPath);
  } catch {
    return { success: false, error: `草稿不存在：${id}` };
  }

  try {
    await fs.rm(draftDir, { recursive: true, force: true });
    logger.info('Role draft rejected', { id });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
