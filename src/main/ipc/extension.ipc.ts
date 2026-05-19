// ============================================================================
// Extension IPC Handlers - extension:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { ExtensionInfo, ExtensionValidationResult } from '../../shared/contract/extension';
import { getExtensionOpsService } from '../services/plugins/extensionOpsService';
import { createLogger } from '../services/infra/logger';
import { isCurrentUserAdmin } from './adminGuard';

const logger = createLogger('ExtensionIPC');

type ExtensionMutationResult = { success: boolean; error?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adminDenied(): ExtensionMutationResult {
  return { success: false, error: 'Extension: Admin permission required' };
}

function validationError(message: string): ExtensionValidationResult {
  return {
    valid: false,
    errors: [{ field: 'extension', message }],
    warnings: [],
  };
}

export function registerExtensionHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.EXTENSION_LIST, async (): Promise<ExtensionInfo[]> => {
    if (!isCurrentUserAdmin()) {
      logger.warn('Denied extension list request for non-admin user');
      throw new Error('Extension: Admin permission required');
    }

    try {
      return await getExtensionOpsService().list();
    } catch (error) {
      logger.error('Failed to list extensions', { error });
      throw error;
    }
  });

  const handleMutation = (
    channel: string,
    action: (...args: unknown[]) => Promise<void>,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<ExtensionMutationResult> => {
      if (!isCurrentUserAdmin()) {
        return adminDenied();
      }

      try {
        await action(...args);
        return { success: true };
      } catch (error) {
        logger.error('Extension operation failed', { channel, error });
        return { success: false, error: errorMessage(error) };
      }
    });
  };

  handleMutation(IPC_CHANNELS.EXTENSION_INSTALL, async (spec) => {
    await getExtensionOpsService().install(String(spec));
  });

  handleMutation(IPC_CHANNELS.EXTENSION_UNINSTALL, async (id) => {
    await getExtensionOpsService().uninstall(String(id));
  });

  handleMutation(IPC_CHANNELS.EXTENSION_ENABLE, async (id) => {
    await getExtensionOpsService().enable(String(id));
  });

  handleMutation(IPC_CHANNELS.EXTENSION_DISABLE, async (id) => {
    await getExtensionOpsService().disable(String(id));
  });

  handleMutation(IPC_CHANNELS.EXTENSION_RELOAD, async (id) => {
    await getExtensionOpsService().reload(typeof id === 'string' && id.length > 0 ? id : undefined);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSION_VALIDATE, async (_event, id: string): Promise<ExtensionValidationResult> => {
    if (!isCurrentUserAdmin()) {
      return validationError('Extension: Admin permission required');
    }

    try {
      return await getExtensionOpsService().validate(id);
    } catch (error) {
      logger.error('Failed to validate extension', { id, error });
      return validationError(errorMessage(error));
    }
  });

  logger.info('Extension IPC handlers registered');
}
