// ============================================================================
// Generation IPC Handlers - generation:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { Generation, GenerationId, GenerationDiff } from '../../shared/types';
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

async function handleSwitch(
  getManager: () => GenerationManager | null,
  payload: { id: GenerationId }
): Promise<Generation> {
  return getManagerOrThrow(getManager).switchGeneration(payload.id);
}

async function handleGetPrompt(
  getManager: () => GenerationManager | null,
  payload: { id: GenerationId }
): Promise<string> {
  return getManagerOrThrow(getManager).getPrompt(payload.id);
}

async function handleCompare(
  getManager: () => GenerationManager | null,
  payload: { id1: GenerationId; id2: GenerationId }
): Promise<GenerationDiff> {
  return getManagerOrThrow(getManager).compareGenerations(payload.id1, payload.id2);
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
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.GENERATION, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'list':
          data = await handleList(getManager);
          break;
        case 'switch':
          data = await handleSwitch(getManager, payload as { id: GenerationId });
          break;
        case 'getPrompt':
          data = await handleGetPrompt(getManager, payload as { id: GenerationId });
          break;
        case 'compare':
          data = await handleCompare(getManager, payload as { id1: GenerationId; id2: GenerationId });
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

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'list' */
  ipcMain.handle(IPC_CHANNELS.GENERATION_LIST, async () => {
    return handleList(getManager);
  });

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'switch' */
  ipcMain.handle(IPC_CHANNELS.GENERATION_SWITCH, async (_, id: GenerationId) => {
    return handleSwitch(getManager, { id });
  });

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'getPrompt' */
  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_PROMPT, async (_, id: GenerationId) => {
    return handleGetPrompt(getManager, { id });
  });

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'compare' */
  ipcMain.handle(
    IPC_CHANNELS.GENERATION_COMPARE,
    async (_, id1: GenerationId, id2: GenerationId) => {
      return handleCompare(getManager, { id1, id2 });
    }
  );

  /** @deprecated Use IPC_DOMAINS.GENERATION with action: 'getCurrent' */
  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_CURRENT, async () => {
    return handleGetCurrent(getManager);
  });
}
