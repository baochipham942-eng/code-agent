// ============================================================================
// OpenChronicle (屏幕记忆) IPC Handlers - openchronicle:* actions
// ============================================================================

import type { IpcMain } from '../platform';
import { OpenchronicleSchemas, type OpenchronicleDomainRequest } from '../../shared/ipc/schemas/openchronicle';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import {
  loadSettings,
  saveSettings,
  setEnabled,
  getStatus,
} from '../services/external/openchronicleSupervisor';
import type { OpenchronicleSettings } from '../../shared/contract/openchronicle';

/**
 * openchronicle 域单源路由表（RQ-183 续作·OPENCHRONICLE 刀）：原 domain switch 4 个 case 平移为默认模式 handler（返回 data，
 * 装配器包 { success: true, data }；updateSettings 先保存再回 { success: true }，setEnabled 解出 enabled 透传）。未知 action 与
 * 抛错恰为装配器缺省（INVALID_ACTION `Unknown action: <action>` / INTERNAL_ERROR + Error.message / String(error)，与原文逐字一致），
 * 零配置。请求体为 null / 非对象时原实现在 try 外解构抛错（IPC reject），现返回 INVALID_ACTION。
 */
const openchronicleRoutes = defineDomainRoutes<OpenchronicleDomainRequest, void>(OpenchronicleSchemas.REQUEST, {
  getSettings: async () => await loadSettings(),
  updateSettings: async (_ctx, requestPayload) => {
    const next = requestPayload as OpenchronicleSettings;
    await saveSettings(next);
    return { success: true };
  },
  setEnabled: async (_ctx, requestPayload) => {
    const { enabled } = requestPayload as { enabled: boolean };
    return await setEnabled(enabled);
  },
  getStatus: async () => await getStatus(),
});

export function registerOpenchronicleHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, openchronicleRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerOpenchronicleHandlers.routes = openchronicleRoutes;
