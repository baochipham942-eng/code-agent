// ============================================================================
// Roles IPC Handlers - domain:roles 通道（持久化角色资产面板）
// ============================================================================
//
// 暴露（设计 §7 角色面板最小版）：
// - action 'list'         -> 角色列表（roleId / 描述 / 记忆条数 / 最近工作）
// - action 'detail'       -> 角色详情（定义原文 / 记忆 / 履历）
// - action 'deleteMemory' -> 删除一条角色记忆
// - action 'updateMemory' -> 编辑一条角色记忆（覆盖写）
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { RolePanelDetail, RolePanelEntry } from '../../shared/contract/roleAssets';
import {
  listPersistentRoles,
  listScopedMemories,
  loadRoleHistory,
  deleteScopedMemory,
  writeScopedMemory,
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

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------

async function handleList(): Promise<RolePanelEntry[]> {
  const roleIds = await listPersistentRoles();
  const agents = new Map(listAllAgents().map((a) => [a.id, a]));

  const entries: RolePanelEntry[] = [];
  for (const roleId of roleIds) {
    const agent = agents.get(roleId);
    const memories = await listScopedMemories({ scope: 'role', roleId });
    const history = await loadRoleHistory(roleId, 1);
    entries.push({
      roleId,
      description: agent?.description ?? '',
      source: agent?.source ?? 'orphan',
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

  const [memories, history] = await Promise.all([
    listScopedMemories({ scope: 'role', roleId }),
    loadRoleHistory(roleId, 50),
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
  };
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
