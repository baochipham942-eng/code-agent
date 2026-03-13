// ============================================================================
// Suggestions IPC Handlers - 智能提示建议
// ============================================================================
// Context-aware suggestions are now pushed via SSE (suggestions_update event)
// This handler remains as a no-op for backward compatibility

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SuggestionsIPC');

export function registerSuggestionsHandlers(_getWorkingDirectory: () => string | null): void {
  ipcMain.handle(IPC_CHANNELS.SUGGESTIONS_GET, async () => {
    // Suggestions are now pushed via SSE after each agent turn
    return [];
  });

  logger.debug('Suggestions IPC handlers registered');
}
