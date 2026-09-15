// ============================================================================
// Agent Registry IPC Handlers - agents:* 通道
// ============================================================================
//
// 暴露：
// - action 'list'  -> listAllAgents()，含 builtin + user + project
// - 主进程主动推送 'agents:changed' 事件给所有 BrowserWindow
// ============================================================================

import type { IpcMain, AppWindow } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { AgentRegistrySchemas, type AgentRegistryDomainRequest } from '../../shared/ipc/schemas/agentRegistry';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import {
  listAllAgentsWithRoleFlag,
  onAgentRegistryChange,
} from '../agent/agentRegistry';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentRegistryIPC');

/**
 * 主进程 → 渲染端推送的事件通道。
 * 同步暴露为 IPC_CHANNELS.AGENTS_CHANGED（type-safe），保留常量便于本模块内部引用。
 */
export const AGENT_REGISTRY_EVENT = IPC_CHANNELS.AGENTS_CHANGED;

/**
 * agents 域（IPC_DOMAINS.AGENT_REGISTRY）单源路由表（RQ-183 续作·AGENT_REGISTRY 刀）：原 domain switch 1 个 case 平移为默认模式
 * handler（返回列表，装配器包 { success: true, data }）。未知 action → UNKNOWN_ACTION + `Unknown agents action:`（unknownActionCode /
 * unknownActionMessage 保持原契约）；抛错进 mapError：原样记 `AgentRegistry IPC error` 日志 + AGENT_REGISTRY_ERROR（非 Error 为
 * 'Unknown error'）。注册期 agents:changed 广播留在装配函数。请求体为 null / 非对象时原实现在 try 外解构抛错（IPC reject），
 * 现返回 UNKNOWN_ACTION。
 */
const agentRegistryRoutes = defineDomainRoutes<AgentRegistryDomainRequest, void>(AgentRegistrySchemas.REQUEST, {
  list: async () => await listAllAgentsWithRoleFlag(),
}, {
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown agents action: ${String(action)}`,
  mapError: (error) => {
    logger.error('AgentRegistry IPC error', error);
    return { code: 'AGENT_REGISTRY_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerAgentRegistryHandlers(
  ipcMain: IpcMain,
  getAllWindows: () => AppWindow[],
): void {
  installDomainRoutes(ipcMain, agentRegistryRoutes, undefined);

  // Broadcast 'agents:changed' to all renderer windows
  onAgentRegistryChange(() => {
    void (async () => {
      try {
        const windows = getAllWindows();
        const entries = await listAllAgentsWithRoleFlag();
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send(AGENT_REGISTRY_EVENT, { agents: entries });
          }
        }
      } catch (err) {
        logger.warn('Failed to broadcast agents:changed', { error: String(err) });
      }
    })();
  });

  logger.info('AgentRegistry IPC handlers registered');
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerAgentRegistryHandlers.routes = agentRegistryRoutes;
