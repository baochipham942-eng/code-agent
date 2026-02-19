// ============================================================================
// Suggestions IPC Handlers - 智能提示建议
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getPromptSuggestions } from '../services/promptSuggestions';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SuggestionsIPC');

export function registerSuggestionsHandlers(getWorkingDirectory: () => string | null): void {
  ipcMain.handle(IPC_CHANNELS.SUGGESTIONS_GET, async () => {
    try {
      const cwd = getWorkingDirectory() || process.cwd();
      const suggestions = await getPromptSuggestions(cwd);
      return suggestions.map(s => ({ id: s.id, text: s.text, source: s.source }));
    } catch (error) {
      logger.error('Failed to get suggestions', { error });
      return [];
    }
  });

  logger.debug('Suggestions IPC handlers registered');
}
