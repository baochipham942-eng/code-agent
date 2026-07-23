// ============================================================================
// Roles IPC Handlers - domain:roles 通道（持久化角色资产面板）
// ============================================================================
//
// 暴露（设计 §7 角色面板最小版）：
// - action 'list'           -> 角色列表（roleId / 描述 / 记忆条数 / 最近工作）
// - action 'detail'         -> 角色详情（定义原文 / 记忆 / 履历 / 主动性配置）
// - action 'deleteMemory'   -> 删除一条角色记忆
// - action 'updateMemory'   -> 编辑一条角色记忆（覆盖写）
// - action 'writeProjectMemory' -> 写一条项目层记忆（资料库归档摘要；同名产物覆盖写）
// - action 'setProactivity' -> 设置角色主动等级（写 settings + 立即同步 cadence cron）
// - action 'listDrafts'     -> 列出待确认的角色草稿（对话式建角色）
// - action 'confirmDraft'   -> 确认草稿：写 agents/<id>.md + 建 roles/<id>/（过安全闸）
// - action 'rejectDraft'    -> 放弃草稿：删草稿目录
// ============================================================================

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type {
  ExpertBindingKind,
  ExpertBindingMode,
  ExpertBindingScope,
  RolePanelDetail,
  RolePanelEntry,
  RoleProactivityLevel,
  RoleVisual,
} from '../../shared/contract/roleAssets';
import { addRoleBinding, readRoleBindings, removeRoleBinding } from '../services/roleAssets/roleContextBindings';
import {
  BUILTIN_ROLE_IDS,
  getBuiltinRoleVisual,
  listPersistentRoles,
  listScopedMemories,
  loadRoleHistory,
  deleteScopedMemory,
  writeScopedMemory,
  resolveRoleProactivityConfig,
  syncCadenceJobs,
  listRoleDrafts,
  confirmRoleDraft,
  rejectRoleDraft,
} from '../services/roleAssets';
import { listAllAgents } from '../agent/agentRegistry';
import { parseAgentMd, parseAgentMdVisual, updateAgentMdBody, updateAgentMdEquipment, updateAgentMdVisual, type AgentMdEquipment } from '../agent/hybrid/agentMdLoader';
import { getAgentsMdDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import { BUILTIN_ROLES } from '../services/roleAssets/builtinRoles';
import { getInstalledRolePackState, getRolePackFactoryDefinition } from '../services/roleAssets/rolePackInstallService';
import { BUILTIN_SKILLS } from '../services/skills/builtinSkillsData';
import { getSkillRepositoryService } from '../services/skills/skillRepositoryService';
import { TOOL_ALIASES } from '../services/toolSearch/deferredTools';
import { getProtocolRegistry } from '../tools/protocolRegistry';

const logger = createLogger('RolesIPC');

// ----------------------------------------------------------------------------
// Payload 类型
// ----------------------------------------------------------------------------

interface RoleIdPayload {
  roleId?: string;
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

interface WriteProjectMemoryPayload {
  workspacePath?: string;
  name?: string;
  description?: string;
  content?: string;
}

interface SetProactivityPayload extends RoleIdPayload {
  level?: string;
  cadence?: string;
}

interface UpdateVisualPayload extends RoleIdPayload {
  visual?: RoleVisual;
}
interface UpdateEquipmentPayload extends RoleIdPayload { equipment?: AgentMdEquipment; }
interface UpdateDefinitionBodyPayload extends RoleIdPayload { body?: string; }

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
      lastWork: history.length > 0 ? history[history.length - 1] : null,
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
    history,
    proactivity,
    visual: getBuiltinRoleVisual(roleId) ?? (definition ? parseAgentMdVisual(definition) : {}),
    isBuiltin: builtinRoleIdSet.has(roleId),
    ...(parsed ? { equipment: { skills: parsed.skills ?? [], tools: parsed.tools, model: parsed.model, maxIterations: parsed.maxIterations, availableSkills, availableTools } } : {}),
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
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  const definition = await fs.readFile(definitionPath, 'utf-8');
  const detail = await handleDetail(roleId);
  const validSkills = new Set(detail.equipment?.availableSkills ?? []);
  const validTools = new Set(detail.equipment?.availableTools ?? []);
  if (equipment.skills.some((skill) => !validSkills.has(skill)) || equipment.tools.some((tool) => !validTools.has(tool))) {
    throw new Error('Equipment includes an unavailable skill or tool');
  }
  await fs.writeFile(definitionPath, updateAgentMdEquipment(definition, equipment), 'utf-8');
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
 * 设置角色主动等级：写入 settings.roleAssets.proactivity.roles[roleId]（最高优先级），
 * 然后立即同步 cadence cron（开 → 注册闹钟；关 → 删除闹钟），不用等重启。
 */
async function handleSetProactivity(roleId: string, level: RoleProactivityLevel, cadence?: string) {
  const { getConfigService } = await import('../services/core/configService');
  await getConfigService().updateSettings({
    roleAssets: {
      proactivity: {
        roles: { [roleId]: { level, ...(cadence ? { cadence } : {}) } },
      },
    },
  });

  // cron 同步失败不阻塞设置保存（headless 测试环境可能没有 cron 服务），下次启动会兜底同步
  const synced = await syncCadenceJobs().catch((error) => {
    logger.warn('syncCadenceJobs after setProactivity failed (will sync on next startup)', error);
    return null;
  });

  return { proactivity: await resolveRoleProactivityConfig(roleId), synced };
}

// ----------------------------------------------------------------------------
// 注册
// ----------------------------------------------------------------------------

export function registerRolesHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.ROLES, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;
    try {
      switch (action) {
        case 'list': {
          return { success: true, data: await handleList() };
        }

        case 'detail': {
          const { roleId } = (payload ?? {}) as RoleIdPayload;
          if (!roleId) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
          }
          return { success: true, data: await handleDetail(roleId) };
        }

        case 'deleteMemory': {
          const { roleId, filename } = (payload ?? {}) as DeleteMemoryPayload;
          if (!roleId || !filename) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and filename are required' } };
          }
          const existed = await deleteScopedMemory({ scope: 'role', roleId }, filename);
          return { success: true, data: { existed } };
        }

        case 'updateMemory': {
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
        }

        case 'writeProjectMemory': {
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
        }

        case 'listBindings': {
          const { roleId } = (payload ?? {}) as RoleIdPayload;
          if (!roleId) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
          }
          return { success: true, data: await readRoleBindings(roleId) };
        }

        case 'addBinding': {
          const { roleId, kind, target, title, mode, scope } = (payload ?? {}) as {
            roleId?: string;
            kind?: ExpertBindingKind;
            target?: string;
            title?: string;
            mode?: ExpertBindingMode;
            scope?: ExpertBindingScope;
          };
          if (!roleId || !kind || !target || !mode || !scope) {
            return {
              success: false,
              error: { code: 'INVALID_ARGS', message: 'roleId, kind, target, mode, scope are required' },
            };
          }
          return { success: true, data: await addRoleBinding(roleId, { kind, target, title, mode, scope }) };
        }

        case 'removeBinding': {
          const { roleId, bindingId } = (payload ?? {}) as { roleId?: string; bindingId?: string };
          if (!roleId || !bindingId) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and bindingId are required' } };
          }
          await removeRoleBinding(roleId, bindingId);
          return { success: true, data: { removed: true } };
        }

        case 'setProactivity': {
          const { roleId, level, cadence } = (payload ?? {}) as SetProactivityPayload;
          if (!roleId || !level || !PROACTIVITY_LEVELS.has(level)) {
            return {
              success: false,
              error: { code: 'INVALID_ARGS', message: 'roleId and level (silent|daily|realtime) are required' },
            };
          }
          return {
            success: true,
            data: await handleSetProactivity(roleId, level as RoleProactivityLevel, cadence),
          };
        }

        case 'updateVisual': {
          const { roleId, visual } = (payload ?? {}) as UpdateVisualPayload;
          if (!roleId || !visual) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and visual are required' } };
          }
          return { success: true, data: await handleUpdateVisual(roleId, visual) };
        }

        case 'updateEquipment': {
          const { roleId, equipment } = (payload ?? {}) as UpdateEquipmentPayload;
          if (!roleId || !equipment) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and equipment are required' } };
          await handleUpdateEquipment(roleId, equipment);
          return { success: true, data: { updated: true } };
        }

        case 'updateDefinitionBody': {
          const { roleId, body } = (payload ?? {}) as UpdateDefinitionBodyPayload;
          if (!roleId || typeof body !== 'string') return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId and body are required' } };
          await handleUpdateDefinitionBody(roleId, body);
          return { success: true, data: { updated: true } };
        }

        case 'restoreFactory': {
          const { roleId } = (payload ?? {}) as RoleIdPayload;
          if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
          await handleRestoreFactory(roleId);
          return { success: true, data: { restored: true } };
        }

        // --- 对话式建角色：草稿队列（role-creation-flow） ---
        case 'listDrafts': {
          return { success: true, data: await listRoleDrafts() };
        }

        case 'confirmDraft': {
          const { draftId } = (payload ?? {}) as DraftIdPayload;
          if (!draftId) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'draftId is required' } };
          }
          const result = await confirmRoleDraft(draftId);
          if (!result.success) {
            return { success: false, error: { code: 'CONFIRM_FAILED', message: result.error ?? 'confirm failed' } };
          }
          return { success: true, data: result };
        }

        case 'rejectDraft': {
          const { draftId } = (payload ?? {}) as DraftIdPayload;
          if (!draftId) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'draftId is required' } };
          }
          const result = await rejectRoleDraft(draftId);
          if (!result.success) {
            return { success: false, error: { code: 'REJECT_FAILED', message: result.error ?? 'reject failed' } };
          }
          return { success: true, data: result };
        }

        case 'rolePackList': {
          const { listRolePacks } = await import('../services/roleAssets/rolePackInstallService');
          return { success: true, data: await listRolePacks() };
        }

        case 'rolePackInstall': {
          const { roleId } = (payload ?? {}) as RoleIdPayload;
          if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
          const { installRolePack } = await import('../services/roleAssets/rolePackInstallService');
          return { success: true, data: await installRolePack(roleId) };
        }

        case 'rolePackUninstall': {
          const { roleId } = (payload ?? {}) as RoleIdPayload;
          if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
          const { uninstallRolePack } = await import('../services/roleAssets/rolePackInstallService');
          return { success: true, data: await uninstallRolePack(roleId) };
        }

        case 'rolePackRetryMissingSkills': {
          const { roleId } = (payload ?? {}) as RoleIdPayload;
          if (!roleId) return { success: false, error: { code: 'INVALID_ARGS', message: 'roleId is required' } };
          const { retryMissingSkills } = await import('../services/roleAssets/rolePackInstallService');
          return { success: true, data: await retryMissingSkills(roleId) };
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown roles action: ${action}` },
          };
      }
    } catch (error) {
      logger.error('Roles IPC error', error);
      return {
        success: false,
        error: {
          code: 'ROLES_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  });

  logger.info('Roles IPC handlers registered');
}
