// ============================================================================
// Generation IPC Handlers - generation:* 通道
// ============================================================================
// Sprint 2: Only list + getCurrent retained

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { Generation, GenerationId } from '../../shared/types';
import type { GenerationManager } from '../generation/generationManager';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

function getManagerOrThrow(getManager: () => GenerationManager | null): GenerationManager {
  const manager = getManager();
  if (!manager) throw new Error('Generation manager not initialized');
  return manager;
}

async function handleList(getManager: () => GenerationManager | null): Promise<Generation[]> {
  return getManagerOrThrow(getManager).getAllGenerations();
}

async function handleGetCurrent(getManager: () => GenerationManager | null): Promise<Generation> {
  return getManagerOrThrow(getManager).getCurrentGeneration();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Generation 相关 IPC handlers
 */
export function registerGenerationHandlers(
  ipcMain: IpcMain,
  getManager: () => GenerationManager | null
): void {
  // ========== New Domain Handler ==========
  ipcMain.handle(IPC_DOMAINS.GENERATION, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'list':
          data = await handleList(getManager);
          break;
        case 'getCurrent':
          data = await handleGetCurrent(getManager);
          break;
        default:
          return {
            success: false,
            error: {
              code: 'INVALID_ACTION',
              message: `Unknown action: ${action}`,
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

  // ========== Legacy Handlers (Deprecated - only list + getCurrent) ==========

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'list' */
  ipcMain.handle(IPC_CHANNELS.GENERATION_LIST, async () => {
    return handleList(getManager);
  });

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'getCurrent' */
  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_CURRENT, async () => {
    return handleGetCurrent(getManager);
  });
}
