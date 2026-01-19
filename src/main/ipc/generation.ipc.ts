// ============================================================================
// Generation IPC Handlers - generation:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { GenerationId } from '../../shared/types';
import type { GenerationManager } from '../generation/GenerationManager';

/**
 * 注册 Generation 相关 IPC handlers
 */
export function registerGenerationHandlers(
  ipcMain: IpcMain,
  getManager: () => GenerationManager | null
): void {
  ipcMain.handle(IPC_CHANNELS.GENERATION_LIST, async () => {
    const manager = getManager();
    if (!manager) throw new Error('Generation manager not initialized');
    return manager.getAllGenerations();
  });

  ipcMain.handle(IPC_CHANNELS.GENERATION_SWITCH, async (_, id: GenerationId) => {
    const manager = getManager();
    if (!manager) throw new Error('Generation manager not initialized');
    return manager.switchGeneration(id);
  });

  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_PROMPT, async (_, id: GenerationId) => {
    const manager = getManager();
    if (!manager) throw new Error('Generation manager not initialized');
    return manager.getPrompt(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.GENERATION_COMPARE,
    async (_, id1: GenerationId, id2: GenerationId) => {
      const manager = getManager();
      if (!manager) throw new Error('Generation manager not initialized');
      return manager.compareGenerations(id1, id2);
    }
  );

  ipcMain.handle(IPC_CHANNELS.GENERATION_GET_CURRENT, async () => {
    const manager = getManager();
    if (!manager) throw new Error('Generation manager not initialized');
    return manager.getCurrentGeneration();
  });
}
