// ============================================================================
// Capability Center IPC
// ============================================================================

import type { IpcMain } from '../platform';
import { CapabilitySchemas, type CapabilityDomainRequest } from '../../shared/ipc/schemas/capability';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type {
  CapabilityInstallDraftRequest,
  CapabilityRemoveDraftRequest,
  CapabilityToggleRequest,
} from '../../shared/contract/capability';
import type { ConfigService } from '../services/core/configService';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { getCapabilityCenterService } from '../services/capabilities/capabilityCenterService';
import { getAdminAccessIpcError } from './adminGuard';

export interface CapabilityIpcDependencies {
  getConfigService: () => ConfigService | null;
  getAppService: () => AgentApplicationService | null;
}

function getWorkingDirectory(getAppService: () => AgentApplicationService | null): string | undefined {
  try {
    return getAppService()?.getWorkingDirectory?.();
  } catch {
    return undefined;
  }
}

/**
 * capability 域单源路由表（RQ-183 续作·CAPABILITY 刀）：原 domain switch 4 个 case 逐 case 平移为默认模式 handler（返回 data，
 * 装配器包 { success: true, data }）。管理员门平移为 guard：除 list 外一律过门（含未知 action，与原「先过门再 switch」同序），
 * 门在装配器 try 内（门抛错落 INTERNAL_ERROR，与原一致）。未知 action 与抛错走装配器缺省（INVALID_ACTION `Unknown action:` /
 * INTERNAL_ERROR，与原文逐字一致）。service 原在 try 外取（抛错即 IPC reject），现在 handler 内取、抛错落 INTERNAL_ERROR；
 * 请求体为 null / 非对象时原实现读 request.action 抛错（IPC reject），现返回 FORBIDDEN 或 INVALID_ACTION。
 */
const capabilityRoutes = defineDomainRoutes<CapabilityDomainRequest, CapabilityIpcDependencies>(
  CapabilitySchemas.REQUEST,
  {
    list: async (deps) => {
      const service = getCapabilityCenterService();
      return await service.listCapabilities({
        workingDirectory: getWorkingDirectory(deps.getAppService),
        configService: deps.getConfigService(),
      });
    },
    setEnabled: async (deps, payload) => {
      const service = getCapabilityCenterService();
      return await service.setEnabled(
        payload as CapabilityToggleRequest,
        {
          workingDirectory: getWorkingDirectory(deps.getAppService),
          configService: deps.getConfigService(),
        },
      );
    },
    installDraft: async (deps, payload) => {
      const service = getCapabilityCenterService();
      return await service.installDraft(
        payload as CapabilityInstallDraftRequest,
        {
          workingDirectory: getWorkingDirectory(deps.getAppService),
          configService: deps.getConfigService(),
        },
      );
    },
    removeDraft: async (deps, payload) => {
      const service = getCapabilityCenterService();
      return await service.removeDraft(
        payload as CapabilityRemoveDraftRequest,
        {
          workingDirectory: getWorkingDirectory(deps.getAppService),
          configService: deps.getConfigService(),
        },
      );
    },
  },
  {
    guard: (action) => (action !== 'list' ? getAdminAccessIpcError('Capability Center') : null),
  },
);

export function registerCapabilityHandlers(
  ipcMain: IpcMain,
  deps: CapabilityIpcDependencies,
): void {
  installDomainRoutes(ipcMain, capabilityRoutes, deps);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerHookHandlers.routes 先例）
registerCapabilityHandlers.routes = capabilityRoutes;
