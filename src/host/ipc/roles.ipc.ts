// ============================================================================
// Roles IPC Handlers - domain:roles 通道（持久化角色资产面板）
// ============================================================================
//
// 暴露（设计 §7 角色面板最小版）：
// - action 'list'           -> 角色列表（roleId / 描述 / 记忆条数 / 最近工作）
// - action 'detail'         -> 角色详情（定义原文 / 记忆 / 履历 / 主动性配置）
// - action 'deleteMemory'   -> 删除一条角色记忆
// - action 'updateMemory'   -> 编辑一条角色记忆（覆盖写）
// - action 'exportMemories'     -> 全部角色记忆汇成一份 Markdown 落「下载」文件夹
// - action 'revealMemoryFolder' -> 在文件管理器中定位角色记忆目录
// - action 'writeProjectMemory' -> 写一条项目层记忆（资料库归档摘要；同名产物覆盖写）
// - action 'setProactivity' -> 设置角色主动性（写 settings + 立即同步 cadence cron）
// - action 'listDrafts'     -> 列出待确认的角色草稿（对话式建角色）
// - action 'confirmDraft'   -> 确认草稿：写 agents/<id>.md + 建 roles/<id>/（过安全闸）
// - action 'rejectDraft'    -> 放弃草稿：删草稿目录
// ============================================================================

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { IpcMain } from '../platform';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { RolesSchemas, type RolesDomainRequest } from '../../shared/ipc/schemas/roles';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type {
  ExpertBindingKind,
  ExpertBindingMode,
  RolePanelDetail,
  RolePanelEntry,
  RoleBoundCronJob,
  RoleProactivityConfig,
  RoleProactivityLevel,
  RoleVisual,
} from '../../shared/contract/roleAssets';
import { addRoleBinding, readRoleBindings, removeRoleBinding } from '../services/roleAssets/roleContextBindings';
import {
  BUILTIN_ROLE_IDS,
  getBuiltinRoleVisual,
  getRoleMemoriesDir,
  listPersistentRoles,
  listScopedMemories,
  loadRoleHistory,
  deleteScopedMemory,
  writeScopedMemory,
  resolveRoleProactivityConfig,
  listRoleDrafts,
  confirmRoleDraft,
  rejectRoleDraft,
  getFirstWakeSnapshot,
  skipFirstWake,
  isSafeRoleId,
} from '../services/roleAssets';
import { writeRoleProactivityConfig } from '../services/roleAssets/roleProactivityWrite';
import type { RoleMemoryFile } from '../services/roleAssets/roleAssetService';
import { handleSaveTextToDownloads } from './workspaceSaveExport';
import { getDatabase } from '../services/core/databaseService';
import { getCronService } from '../cron/cronService';
import { normalizeSchedule, parseJsonValue, isRecord } from '../cron/cronNormalizers';
import { listAllAgents } from '../agent/agentRegistry';
import { parseAgentMd, parseAgentMdVisual, updateAgentMdBody, updateAgentMdEquipment, updateAgentMdVisual, type AgentMdEquipment } from '../agent/hybrid/agentMdLoader';
import { getAgentsMdDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import { BUILTIN_ROLES } from '../services/roleAssets/builtinRoles';
import { readRolePersonalization, writeRolePersonalization } from '../services/roleAssets/rolePersonalization';
import { getInstalledRolePackState, getRolePackFactoryDefinition } from '../services/roleAssets/rolePackInstallService';
import { BUILTIN_SKILLS } from '../services/skills/builtinSkillsData';
import { getSkillRepositoryService } from '../services/skills/skillRepositoryService';
import { TOOL_ALIASES } from '../services/toolSearch/deferredTools';
import { getProtocolRegistry } from '../tools/protocolRegistry';
import { findRecommendedMcpServer } from '../../shared/constants/mcpCatalog';
import { isManifestBackedAgentEngineKind } from '../../shared/externalEngineManifest';

const logger = createLogger('RolesIPC');

const ROLE_HISTORY_PREFIX = /^-\s*/;
const ROLE_HISTORY_WORKDIR = /\[工作目录\s*:\s*[^\]]*\]/g;
const ROLE_HISTORY_ABSOLUTE_PATH = /(?:\/(?:Users|private|tmp|var|home|opt|etc|Applications|Volumes)\/|~\/|[A-Za-z]:\\)[^\s，。；、！？)\]}>"'`]+/g;

function cleanLastWorkText(text: string): string {
  return text
    .replace(ROLE_HISTORY_WORKDIR, ' ')
    .replace(ROLE_HISTORY_ABSOLUTE_PATH, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeLastWork(line: string): string {
  const normalizedLine = line.replace(ROLE_HISTORY_PREFIX, '');
  const segments = normalizedLine.split(' | ');
  if (segments.length < 3) {
    return cleanLastWorkText(normalizedLine);
  }

  const [date, label, ...summarySegments] = segments;
  const summary = cleanLastWorkText(summarySegments.join(' | '));
  const visibleWork = summary || cleanLastWorkText(label);
  return [cleanLastWorkText(date), visibleWork].filter(Boolean).join(' ');
}

// ----------------------------------------------------------------------------
// Payload 类型
// ----------------------------------------------------------------------------

interface RoleIdPayload {
  roleId?: string;
}

type CronBindingRow = {
  id: string;
  name: string;
  schedule: string;
  action: string;
  enabled: number;
  last_run_at: number | null;
  last_status?: string | null;
  last_error?: string | null;
};

const BOUND_EXECUTION_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'paused', 'interrupted'] as const;
const LAST_ERROR_MAX = 120;

function boundExecutionStatus(raw: unknown): RoleBoundCronJob['lastStatus'] {
  return typeof raw === 'string' && (BOUND_EXECUTION_STATUSES as readonly string[]).includes(raw)
    ? raw as RoleBoundCronJob['lastStatus']
    : undefined;
}

/** 详情行只展示一句原因：丢掉堆栈帧，超长首行截断。 */
function shortExecutionError(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = raw
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^at\s+\S/.test(part));
  if (!line) return undefined;
  return line.length <= LAST_ERROR_MAX ? line : `${line.slice(0, LAST_ERROR_MAX - 1)}…`;
}

function getBoundActionType(action: unknown, roleId: string): RoleBoundCronJob['actionType'] | null {
  if (!isRecord(action) || action.roleId !== roleId) return null;
  if (action.type === 'agent') return 'agent';
  if (action.type === 'role-wake') return 'role_wake';
  return null;
}

function handleListBoundCronJobs(roleId: string): RoleBoundCronJob[] {
  const db = getDatabase().getDb();
  if (!db) return [];
  // 本机 cron 通常只有十位数；为详情页扫描并 JSON.parse action 足够，避免为这个低频反查增加 roleId 列、索引或迁移负担。
  // 时间与状态、错误取同一条最新执行（COALESCE 与原先 last_run_at 同一口径），不另开列、不迁移。
  const rows = db.prepare(`
    SELECT j.id, j.name, j.schedule, j.action, j.enabled,
      COALESCE(e.completed_at, e.started_at, e.scheduled_at) AS last_run_at,
      e.status AS last_status,
      e.error AS last_error
    FROM cron_jobs j
    LEFT JOIN cron_executions e ON e.id = (
      SELECT e2.id
      FROM cron_executions e2
      WHERE e2.job_id = j.id
      ORDER BY COALESCE(e2.completed_at, e2.started_at, e2.scheduled_at) DESC, e2.rowid DESC
      LIMIT 1
    )
  `).all() as CronBindingRow[];
  const nextRuns = new Map(getCronService().listJobs().map((job) => [job.id, job.nextRunAt]));
  const bindings: RoleBoundCronJob[] = [];
  for (const row of rows) {
    const actionType = getBoundActionType(parseJsonValue(row.action), roleId);
    const schedule = normalizeSchedule(parseJsonValue(row.schedule));
    if (!actionType || !schedule) continue;
    const lastStatus = boundExecutionStatus(row.last_status);
    const lastError = shortExecutionError(row.last_error);
    bindings.push({
      id: row.id,
      name: row.name,
      schedule,
      enabled: Boolean(row.enabled),
      ...(nextRuns.get(row.id) !== undefined ? { nextRunAt: nextRuns.get(row.id) } : {}),
      ...(typeof row.last_run_at === 'number' ? { lastRunAt: row.last_run_at } : {}),
      ...(lastStatus ? { lastStatus } : {}),
      ...(lastError ? { lastError } : {}),
      actionType,
    });
  }
  return bindings;
}

interface DeleteMemoryPayload extends RoleIdPayload {
  filename?: string;
}

interface UpdateMemoryPayload extends RoleIdPayload {
  filename?: string;
  name?: string;
  description?: string;
  content?: string;
}

/** 导出文件名里允许保留的展示名形态：文件系统元字符压成空格，空白收敛成单空格 */
function sanitizeMemoryExportStem(displayName: string): string {
  // eslint-disable-next-line no-control-regex -- 文件名里控制字符正是要剥离的目标，不是误写
  return displayName.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim() || 'role';
}

function memoryExportDateStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 角色记忆导出摘要（N-ROLE-MEMORY-EXPORT）：条目顺序与 detail 页一致
 * （同一 listScopedMemories 顺序），字段覆盖 UI 所见（name/description/filename/content）
 * 加最后修改时间；页眉标注这是本地记忆、不含云端副本。
 */
function buildRoleMemoriesMarkdown(
  displayName: string,
  roleId: string,
  memories: readonly RoleMemoryFile[],
  exportedAt: Date,
): string {
  const sections = memories.map((memory) => [
    `## ${memory.name}`,
    '',
    `- Description: ${memory.description}`,
    `- Last modified: ${memory.updatedAt}`,
    `- File: ${memory.filename}`,
    '',
    memory.content,
  ].join('\n'));
  return [
    `# ${displayName} Memories`,
    '',
    `- Role ID: ${roleId}`,
    `- Exported at: ${exportedAt.toISOString()}`,
    `- Memories: ${memories.length}`,
    '- Scope: local memories only; the cloud copy is not included.',
    '',
    sections.join('\n\n---\n\n'),
    '',
  ].join('\n');
}

interface WriteProjectMemoryPayload {
  workspacePath?: string;
  name?: string;
  description?: string;
  content?: string;
}

interface SetProactivityPayload extends RoleIdPayload {
  level?: string;
  cadence?: string;
  quietHours?: RoleProactivityConfig['quietHours'];
  topicsInclude?: string[];
  topicsExclude?: string[];
}

interface UpdateVisualPayload extends RoleIdPayload {
  visual?: RoleVisual;
}
interface UpdateEquipmentPayload extends RoleIdPayload { equipment?: AgentMdEquipment; }
interface UpdateDefinitionBodyPayload extends RoleIdPayload { body?: string; }
interface UpdatePersonalizationPayload extends RoleIdPayload {
  userExpectation?: string;
  soul?: string;
  boundaries?: { disallowExternalSending: boolean };
}

interface DraftIdPayload {
  draftId?: string;
}

const PROACTIVITY_LEVELS: ReadonlySet<string> = new Set(['silent', 'daily', 'realtime']);

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------

// 预设角色安装到用户目录后 agentRegistry 报 source: 'user'，
// 面板需要按 roleId 对照预设清单还原成 'builtin'（显示"预设"标签）
const builtinRoleIdSet = new Set<string>(BUILTIN_ROLE_IDS);

async function loadFrontmatterVisual(roleId: string): Promise<RoleVisual> {
  try {
    return parseAgentMdVisual(await fs.readFile(path.join(getAgentsMdDir().user, `${roleId}.md`), 'utf-8'));
  } catch {
    return {};
  }
}

async function resolveVisual(roleId: string): Promise<RoleVisual> {
  // 内置角色的编译期身份优先，用户编辑 agent.md 不会伪装或覆盖预设展示。
  return getBuiltinRoleVisual(roleId) ?? await loadFrontmatterVisual(roleId);
}

async function handleList(): Promise<RolePanelEntry[]> {
  const roleIds = await listPersistentRoles();
  const agents = new Map(listAllAgents().map((a) => [a.id, a]));

  const entries: RolePanelEntry[] = [];
  for (const roleId of roleIds) {
    const agent = agents.get(roleId);
    const memories = await listScopedMemories({ scope: 'role', roleId });
    const history = await loadRoleHistory(roleId, 1);
    const source = agent
      ? (builtinRoleIdSet.has(roleId) ? 'builtin' : agent.source)
      : 'orphan';
    const visual = await resolveVisual(roleId);
    entries.push({
      roleId,
      description: agent?.description ?? '',
      source,
      memoryCount: memories.length,
      lastWork: history.length > 0 ? sanitizeLastWork(history[history.length - 1]) || null : null,
      icon: visual?.icon,
      category: visual?.category,
      displayName: visual?.displayName,
      profession: visual?.profession,
      tags: visual?.tags,
      quickPrompts: visual?.quickPrompts,
    });
  }
  return entries;
}

async function handleDetail(roleId: string): Promise<RolePanelDetail> {
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  let definition: string | null;
  try {
    definition = await fs.readFile(definitionPath, 'utf-8');
  } catch {
    definition = null;
  }

  const [memories, history, proactivity] = await Promise.all([
    listScopedMemories({ scope: 'role', roleId }),
    loadRoleHistory(roleId, 50),
    resolveRoleProactivityConfig(roleId),
  ]);

  const parsed = definition ? parseAgentMd(definition, `${roleId}.md`) : null;
  const skillRepository = getSkillRepositoryService();
  await skillRepository.initialize();
  const availableSkills = [...new Set([
    ...BUILTIN_SKILLS.map((skill) => skill.name),
    ...skillRepository.getAllSkills().filter((skill) => skill.enabled).map((skill) => skill.name),
  ])].sort();
  // Protocol registry 是当前已注册的真实集合；TOOL_ALIASES 是 subagent 装配时实际调用的兼容名真源，
  // 两者合并后才不会把已有 legacy frontmatter 工具误判为无效。
  const availableTools = [...new Set([
    ...getProtocolRegistry().getSchemas().map((tool) => tool.name),
    ...Object.keys(TOOL_ALIASES),
  ])].sort();
  const packState = builtinRoleIdSet.has(roleId) ? null : await getInstalledRolePackState(roleId);
  const factory = builtinRoleIdSet.has(roleId)
    ? { agentMd: BUILTIN_ROLES.find((role) => role.id === roleId)?.agentMd }
    : packState ? await getRolePackFactoryDefinition(roleId) : null;
  const restore = builtinRoleIdSet.has(roleId)
    ? { available: Boolean(factory?.agentMd) }
    : packState ? { available: Boolean(factory?.agentMd), ...(!factory?.agentMd ? { disabledReason: '当前无法取得云端出厂定义' } : {}) } : undefined;
  return {
    roleId,
    definition,
    definitionPath,
    memories: memories.map((m) => ({
      filename: m.filename,
      name: m.name,
      description: m.description,
      content: m.content,
      updatedAt: m.updatedAt,
    })),
    // 与 lastWork 同一边界收口：详情页「记录」tab 也不吐内部产物标签与文件系统路径
    history: history.map((line) => sanitizeLastWork(line)).filter(Boolean),
    proactivity,
    visual: getBuiltinRoleVisual(roleId) ?? (definition ? parseAgentMdVisual(definition) : {}),
    isBuiltin: builtinRoleIdSet.has(roleId),
    personalization: readRolePersonalization(roleId),
    ...(parsed?.connectors?.length
      ? {
          recommendedConnectors: parsed.connectors.map((connector) => ({
            id: connector.id,
            label: findRecommendedMcpServer(connector.id)?.name || connector.id,
            level: connector.level,
            ...(connector.reason ? { reason: connector.reason } : {}),
          })),
        }
      : {}),
    ...(parsed ? { equipment: { skills: parsed.skills ?? [], tools: parsed.tools, model: parsed.model, ...(parsed.engine ? { engine: parsed.engine } : {}), ...(parsed.modelOverride ? { modelOverride: parsed.modelOverride } : {}), ...(parsed.permissionPreset ? { permissionPreset: parsed.permissionPreset } : {}), maxIterations: parsed.maxIterations, availableSkills, availableTools } } : {}),
    ...(packState ? { locallyModified: packState.locallyModified } : {}),
    ...(restore ? { restore } : {}),
  };
}

async function handleUpdateVisual(roleId: string, visual: RoleVisual): Promise<RoleVisual> {
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  const definition = await fs.readFile(definitionPath, 'utf-8');
  await fs.writeFile(definitionPath, updateAgentMdVisual(definition, visual), 'utf-8');
  // 内置角色仍返回编译内 visual，写回只保存用户的定义修改，不改其产品身份。
  return resolveVisual(roleId);
}

async function handleUpdateEquipment(roleId: string, equipment: AgentMdEquipment): Promise<void> {
  if (!['fast', 'balanced', 'powerful'].includes(equipment.model) || !Number.isInteger(equipment.maxIterations) || equipment.maxIterations < 1 || equipment.maxIterations > 200) {
    throw new Error('Invalid equipment configuration');
  }
  if (equipment.engine != null && !isManifestBackedAgentEngineKind(equipment.engine)) {
    throw new Error('Invalid agent engine');
  }
  // 只接受三个合法档位或显式清除；不认的值一律拒绝，避免把脏值写进 frontmatter。
  const preset = equipment.permissionPreset;
  if (preset != null && !['strict', 'development', 'ci'].includes(preset)) {
    throw new Error('Invalid permission preset');
  }
  // 指定模型只校验形状；provider 是否可用交给路由层兜底（用户后来删了 key 也不该让保存失败）。
  const override = equipment.modelOverride;
  if (override != null && !(typeof override.provider === 'string' && override.provider.trim() && typeof override.model === 'string' && override.model.trim())) {
    throw new Error('Invalid model override');
  }
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  const definition = await fs.readFile(definitionPath, 'utf-8');
  const persistedEngine = equipment.engine === undefined
    ? parseAgentMd(definition, `${roleId}.md`)?.engine
    : equipment.engine;
  const detail = await handleDetail(roleId);
  const validSkills = new Set(detail.equipment?.availableSkills ?? []);
  const validTools = new Set(detail.equipment?.availableTools ?? []);
  if (equipment.skills.some((skill) => !validSkills.has(skill)) || equipment.tools.some((tool) => !validTools.has(tool))) {
    throw new Error('Equipment includes an unavailable skill or tool');
  }
  await fs.writeFile(
    definitionPath,
    updateAgentMdEquipment(definition, { ...equipment, engine: persistedEngine }),
    'utf-8',
  );
}

async function handleUpdateDefinitionBody(roleId: string, body: string): Promise<void> {
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  const definition = await fs.readFile(definitionPath, 'utf-8');
  await fs.writeFile(definitionPath, updateAgentMdBody(definition, body), 'utf-8');
}

async function handleRestoreFactory(roleId: string): Promise<void> {
  const builtin = BUILTIN_ROLES.find((role) => role.id === roleId);
  const definition = builtin?.agentMd ?? (await getRolePackFactoryDefinition(roleId))?.agentMd;
  if (!definition) throw new Error('Factory definition is unavailable');
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  await fs.writeFile(definitionPath, definition, 'utf-8');
}

/**
 * 设置角色主动性：写 settings 覆盖层 + 立即同步 cadence cron。
 * 写路径单一真源在 roleProactivityWrite（chat 工具 set_role_proactivity 共用），IPC 层只做参数校验。
 */
async function handleSetProactivity(
  roleId: string,
  level: RoleProactivityLevel,
  cadence?: string,
  quietHours?: RoleProactivityConfig['quietHours'],
  topicsInclude?: string[],
  topicsExclude?: string[],
) {
  return writeRoleProactivityConfig(roleId, { level, cadence, quietHours, topicsInclude, topicsExclude });
}

// ----------------------------------------------------------------------------
// 注册
// ----------------------------------------------------------------------------

/**
 * roles 域单源路由表（RQ-183 续作·ROLES 刀）：原 domain switch 22 个 case 由脚本逐 case 平移（rawResponse：handler 仍返回
 * 完整 IPCResponse，含 INVALID_ARGS / CONFIRM_FAILED / REJECT_FAILED 失败响应，case 体原文只改缩进）；未知 action →
 * UNKNOWN_ACTION `Unknown roles action: <action>`；抛错 → ROLES_ERROR（Error 取 message、非 Error 取 'Unknown error'）+
 * `Roles IPC error` 日志。请求体为 null / 非对象时，原实现在 try 外解构抛错（IPC reject），现返回 UNKNOWN_ACTION。
 */
const rolesHandlers: RawDomainRouteHandlers<RolesDomainRequest, void> = {
  list: async (_ctx, _payload) => {
    return { success: true, data: await handleList() };
  },
  detail: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    }
    return { success: true, data: await handleDetail(roleId) };
  },
  listBoundCronJobs: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    return { success: true, data: handleListBoundCronJobs(roleId) };
  },
  deleteMemory: async (_ctx, payload) => {
    const { roleId, filename } = (payload ?? {}) as DeleteMemoryPayload;
    if (!roleId || !filename) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and filename are required' } };
    }
    const existed = await deleteScopedMemory({ scope: 'role', roleId }, filename);
    return { success: true, data: { existed } };
  },
  updateMemory: async (_ctx, payload) => {
    const { roleId, filename, name, description, content } = (payload ?? {}) as UpdateMemoryPayload;
    if (!roleId || !filename || !name || !description || !content) {
      return {
        success: false,
        error: { code: 'INVALID_ARGS', message: 'roleId, filename, name, description, content are required' },
      };
    }
    const filePath = await writeScopedMemory(
      { scope: 'role', roleId },
      { filename, name, description, content },
    );
    return { success: true, data: { path: filePath } };
  },
  exportMemories: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    }
    // 与 detail 页同一来源、同一顺序（listScopedMemories 的 readdir 顺序），导出逐条对得上屏
    const memories = await listScopedMemories({ scope: 'role', roleId });
    if (memories.length === 0) {
      return { success: false, error: { code: 'NOTHING_TO_EXPORT', message: 'This role has no memories to export' } };
    }
    const visual = await resolveVisual(roleId);
    const displayName = visual.displayName?.trim() || roleId;
    const now = new Date();
    const { filePath } = await handleSaveTextToDownloads({
      fileName: `${sanitizeMemoryExportStem(displayName)}-memories-${memoryExportDateStamp(now)}.md`,
      content: buildRoleMemoriesMarkdown(displayName, roleId, memories, now),
    });
    return { success: true, data: { filePath, count: memories.length } };
  },
  revealMemoryFolder: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    }
    // 路径由 host 侧 getRoleMemoriesDir 派生（绝对路径）；不安全的 roleId 会在里面直接抛错
    const { shell } = await import('../platform');
    shell.showItemInFolder(getRoleMemoriesDir(roleId));
    return { success: true, data: { revealed: true } };
  },
  writeProjectMemory: async (_ctx, payload) => {
    const { workspacePath, name, description, content } = (payload ?? {}) as WriteProjectMemoryPayload;
    if (!workspacePath || !name || !description || !content) {
      return {
        success: false,
        error: { code: 'INVALID_ARGS', message: 'workspacePath, name, description, content are required' },
      };
    }
    // 文件名按 name 哈希：同一产物重复归档覆盖同一条记忆，不产生重复条目
    const filename = `archive-${createHash('sha256').update(name).digest('hex').slice(0, 12)}.md`;
    const filePath = await writeScopedMemory(
      { scope: 'project', workspacePath },
      { filename, name, description, content },
    );
    return { success: true, data: { path: filePath } };
  },
  listBindings: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    }
    return { success: true, data: await readRoleBindings(roleId) };
  },
  addBinding: async (_ctx, payload) => {
    // 旧 renderer 可能多带一个已废弃的 scope 字段：解构不取即忽略
    const { roleId, kind, target, title, mode } = (payload ?? {}) as {
      roleId?: string;
      kind?: ExpertBindingKind;
      target?: string;
      title?: string;
      mode?: ExpertBindingMode;
    };
    if (!roleId || !kind || !target || !mode) {
      return {
        success: false,
        error: { code: 'INVALID_ARGS', message: 'roleId, kind, target, mode are required' },
      };
    }
    return { success: true, data: await addRoleBinding(roleId, { kind, target, title, mode }) };
  },
  removeBinding: async (_ctx, payload) => {
    const { roleId, bindingId } = (payload ?? {}) as { roleId?: string; bindingId?: string };
    if (!roleId || !bindingId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and bindingId are required' } };
    }
    await removeRoleBinding(roleId, bindingId);
    return { success: true, data: { removed: true } };
  },
  setProactivity: async (_ctx, payload) => {
    const { roleId, level, cadence, quietHours, topicsInclude, topicsExclude } = (payload ?? {}) as SetProactivityPayload;
    if (!roleId || !level || !PROACTIVITY_LEVELS.has(level)) {
      return {
        success: false,
        error: { code: 'INVALID_ARGS', message: 'roleId and level (silent|daily|realtime) are required' },
      };
    }
    if (quietHours && !(
      /^([01]\d|2[0-3]):[0-5]\d$/.test(quietHours.start)
      && /^([01]\d|2[0-3]):[0-5]\d$/.test(quietHours.end)
      && quietHours.start !== quietHours.end
    )) {
      return {
        success: false,
        error: { code: 'INVALID_ARGS', message: 'quietHours must contain distinct start/end values in HH:mm format' },
      };
    }
    if (topicsInclude !== undefined && !Array.isArray(topicsInclude)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'topicsInclude must be a string array' } };
    }
    if (topicsExclude !== undefined && !Array.isArray(topicsExclude)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'topicsExclude must be a string array' } };
    }
    return {
      success: true,
      data: await handleSetProactivity(
        roleId,
        level as RoleProactivityLevel,
        cadence,
        quietHours,
        topicsInclude,
        topicsExclude,
      ),
    };
  },
  updateVisual: async (_ctx, payload) => {
    const { roleId, visual } = (payload ?? {}) as UpdateVisualPayload;
    if (!roleId || !visual) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and visual are required' } };
    }
    return { success: true, data: await handleUpdateVisual(roleId, visual) };
  },
  updateEquipment: async (_ctx, payload) => {
    const { roleId, equipment } = (payload ?? {}) as UpdateEquipmentPayload;
    if (!roleId || !equipment) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and equipment are required' } };
    await handleUpdateEquipment(roleId, equipment);
    return { success: true, data: { updated: true } };
  },
  updateDefinitionBody: async (_ctx, payload) => {
    const { roleId, body } = (payload ?? {}) as UpdateDefinitionBodyPayload;
    if (!roleId || typeof body !== 'string') return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and body are required' } };
    await handleUpdateDefinitionBody(roleId, body);
    return { success: true, data: { updated: true } };
  },
  updatePersonalization: async (_ctx, payload) => {
    const { roleId, userExpectation, soul, boundaries } = (payload ?? {}) as UpdatePersonalizationPayload;
    if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    if (userExpectation === undefined && soul === undefined && boundaries === undefined) return { success: false, error: { code: 'INVALID_ARGS', message: 'nothing to update' } };
    if ((userExpectation !== undefined && typeof userExpectation !== 'string') || (soul !== undefined && typeof soul !== 'string')) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'userExpectation and soul must be strings' } };
    }
    if (boundaries !== undefined && (
      typeof boundaries !== 'object'
      || boundaries === null
      || typeof boundaries.disallowExternalSending !== 'boolean'
    )) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'boundaries.disallowExternalSending must be a boolean' } };
    }
    writeRolePersonalization(roleId, {
      ...(userExpectation !== undefined ? { userExpectation } : {}),
      ...(soul !== undefined ? { soul } : {}),
      ...(boundaries !== undefined ? { boundaries } : {}),
    });
    return { success: true, data: { updated: true } };
  },
  restoreFactory: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    await handleRestoreFactory(roleId);
    return { success: true, data: { restored: true } };
  },
  // --- 对话式建角色：草稿队列（role-creation-flow） ---
  listDrafts: async (_ctx, _payload) => {
    return { success: true, data: await listRoleDrafts() };
  },
  confirmDraft: async (_ctx, payload) => {
    const { draftId } = (payload ?? {}) as DraftIdPayload;
    if (!draftId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'draftId is required' } };
    }
    const result = await confirmRoleDraft(draftId);
    if (!result.success) {
      return { success: false, error: { code: 'CONFIRM_FAILED', message: result.error ?? 'confirm failed' } };
    }
    return { success: true, data: result };
  },
  rejectDraft: async (_ctx, payload) => {
    const { draftId } = (payload ?? {}) as DraftIdPayload;
    if (!draftId) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'draftId is required' } };
    }
    const result = await rejectRoleDraft(draftId);
    if (!result.success) {
      return { success: false, error: { code: 'REJECT_FAILED', message: result.error ?? 'reject failed' } };
    }
    return { success: true, data: result };
  },
  rolePackList: async (_ctx, _payload) => {
    const { listRolePacks } = await import('../services/roleAssets/rolePackInstallService');
    return { success: true, data: await listRolePacks() };
  },
  rolePackInstall: async (_ctx, payload) => {
    const { roleId, acceptElevation, elevationReviewed } = (payload ?? {}) as RoleIdPayload & { acceptElevation?: boolean; elevationReviewed?: boolean };
    if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    const { installRolePack } = await import('../services/roleAssets/rolePackInstallService');
    return { success: true, data: await installRolePack(roleId, { acceptElevation, elevationReviewed }) };
  },
  rolePackUninstall: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    const { uninstallRolePack } = await import('../services/roleAssets/rolePackInstallService');
    return { success: true, data: await uninstallRolePack(roleId) };
  },
  rolePackRetryMissingSkills: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
    const { retryMissingSkills } = await import('../services/roleAssets/rolePackInstallService');
    return { success: true, data: await retryMissingSkills(roleId) };
  },
  // --- 首次醒来（新角色的只读介绍 + 可委托建议） ---
  firstWakeGet: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId || !isSafeRoleId(roleId)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'a safe roleId is required' } };
    }
    return { success: true, data: await getFirstWakeSnapshot(roleId) };
  },
  // --- 每日醒来的外部增量提议卡（N-ROLE-WAKE-FIND-WORK） ---
  wakeProposalsList: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId || !isSafeRoleId(roleId)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'a safe roleId is required' } };
    }
    const { listWakeProposals } = await import('../services/roleAssets/roleWakeFindWork');
    return { success: true, data: await listWakeProposals(roleId) };
  },
  wakeProposalsAccept: async (_ctx, payload) => {
    const { roleId, title } = (payload ?? {}) as RoleIdPayload & { title?: string };
    if (!roleId || !isSafeRoleId(roleId) || !title?.trim()) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'a safe roleId and title are required' } };
    }
    const { acceptWakeProposal } = await import('../services/roleAssets/roleWakeFindWork');
    const accepted = await acceptWakeProposal(roleId, title);
    if (!accepted) return { success: false, error: { code: 'NOT_FOUND', message: 'proposal not found' } };
    return { success: true, data: accepted };
  },
  wakeProposalsDismiss: async (_ctx, payload) => {
    const { roleId, title } = (payload ?? {}) as RoleIdPayload & { title?: string };
    if (!roleId || !isSafeRoleId(roleId) || !title?.trim()) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'a safe roleId and title are required' } };
    }
    const { dismissWakeProposal } = await import('../services/roleAssets/roleWakeFindWork');
    return { success: true, data: await dismissWakeProposal(roleId, title) };
  },
  firstWakeSkip: async (_ctx, payload) => {
    const { roleId } = (payload ?? {}) as RoleIdPayload;
    if (!roleId || !isSafeRoleId(roleId)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'a safe roleId is required' } };
    }
    const result = await skipFirstWake(roleId);
    if (!result.success) {
      return { success: false, error: { code: 'FIRST_WAKE_SKIP_FAILED', message: 'skip failed' } };
    }
    return { success: true, data: { success: true } };
  },
};

const rolesRoutes = defineDomainRoutes<RolesDomainRequest, void>(RolesSchemas.REQUEST, rolesHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown roles action: ${String(action)}`,
  mapError: (error) => {
    logger.error('Roles IPC error', error);
    return { code: 'ROLES_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerRolesHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, rolesRoutes, undefined);
  logger.info('Roles IPC handlers registered');
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerRolesHandlers.routes = rolesRoutes;
