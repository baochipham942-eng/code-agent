// ============================================================================
// Roles IPC Handlers - domain:roles 通道（持久化角色资产面板）
// ============================================================================
//
// 暴露（设计 §7 角色面板最小版）：
// - action 'list'           -> 角色列表（roleId / 描述 / 记忆条数 / 最近工作）
// - action 'detail'         -> 角色详情（定义原文 / 记忆 / 履历 / 主动性配置）
// - action 'deleteMemory'   -> 删除一条角色记忆
// - action 'updateMemory'   -> 编辑一条角色记忆（覆盖写）
// - action 'setProactivity' -> 设置角色主动等级（写 settings + 立即同步 cadence cron）
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { RolePanelDetail, RolePanelEntry, RoleProactivityLevel } from '../../shared/contract/roleAssets';
import {
  BUILTIN_ROLE_IDS,
  listPersistentRoles,
  listScopedMemories,
  loadRoleHistory,
  deleteScopedMemory,
  writeScopedMemory,
  resolveRoleProactivityConfig,
  syncCadenceJobs,
} from '../services/roleAssets';
import { listAllAgents } from '../agent/agentRegistry';
import { getAgentsMdDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';

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

interface SetProactivityPayload extends RoleIdPayload {
  level?: string;
  cadence?: string;
}

const PROACTIVITY_LEVELS: ReadonlySet<string> = new Set(['silent', 'daily', 'realtime']);

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------

// 预设角色安装到用户目录后 agentRegistry 报 source: 'user'，
// 面板需要按 roleId 对照预设清单还原成 'builtin'（显示"预设"标签）
const builtinRoleIdSet = new Set<string>(BUILTIN_ROLE_IDS);

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
    entries.push({
      roleId,
      description: agent?.description ?? '',
      source,
      memoryCount: memories.length,
      lastWork: history.length > 0 ? history[history.length - 1] : null,
    });
  }
  return entries;
}

async function handleDetail(roleId: string): Promise<RolePanelDetail> {
  const definitionPath = path.join(getAgentsMdDir().user, `${roleId}.md`);
  let definition: string | null = null;
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
  };
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
