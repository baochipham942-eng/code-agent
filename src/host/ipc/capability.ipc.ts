// ============================================================================
// Capability Center IPC
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
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

export function registerCapabilityHandlers(
  ipcMain: IpcMain,
  deps: CapabilityIpcDependencies,
): void {
  ipcMain.handle(IPC_DOMAINS.CAPABILITY, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const service = getCapabilityCenterService();

    try {
      if (request.action !== 'list') {
        const accessError = getAdminAccessIpcError('Capability Center');
        if (accessError) return accessError;
      }

      let data: unknown;
      switch (request.action) {
        case 'list':
          data = await service.listCapabilities({
            workingDirectory: getWorkingDirectory(deps.getAppService),
            configService: deps.getConfigService(),
          });
          break;
        case 'setEnabled':
          data = await service.setEnabled(
            request.payload as CapabilityToggleRequest,
            {
              workingDirectory: getWorkingDirectory(deps.getAppService),
              configService: deps.getConfigService(),
            },
          );
          break;
        case 'installDraft':
          data = await service.installDraft(
            request.payload as CapabilityInstallDraftRequest,
            {
              workingDirectory: getWorkingDirectory(deps.getAppService),
              configService: deps.getConfigService(),
            },
          );
          break;
        case 'removeDraft':
          data = await service.removeDraft(
            request.payload as CapabilityRemoveDraftRequest,
            {
              workingDirectory: getWorkingDirectory(deps.getAppService),
              configService: deps.getConfigService(),
            },
          );
          break;
        default:
          return {
            success: false,
            error: {
              code: 'INVALID_ACTION',
              message: `Unknown action: ${request.action}`,
            },
          };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
