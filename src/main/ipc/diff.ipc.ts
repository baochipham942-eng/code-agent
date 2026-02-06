// ============================================================================
// Diff IPC Handlers
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getDiffTracker } from '../services/diff/diffTracker';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DiffIPC');

export function registerDiffHandlers(): void {
  ipcMain.handle(IPC_DOMAINS.DIFF, async (_event, request: IPCRequest) => {
    const { action, payload } = request;
    const tracker = getDiffTracker();

    try {
      switch (action) {
        case 'getSessionDiffs': {
          const { sessionId } = payload as { sessionId: string };
          const diffs = tracker.getDiffsForSession(sessionId);
          return { success: true, data: diffs } satisfies IPCResponse;
        }

        case 'getMessageDiffs': {
          const { sessionId, messageId } = payload as { sessionId: string; messageId: string };
          const diffs = tracker.getDiffsForMessage(sessionId, messageId);
          return { success: true, data: diffs } satisfies IPCResponse;
        }

        case 'getFileDiffs': {
          const { sessionId, filePath } = payload as { sessionId: string; filePath: string };
          const diffs = tracker.getDiffsForFile(sessionId, filePath);
          return { success: true, data: diffs } satisfies IPCResponse;
        }

        case 'getSummary': {
          const { sessionId } = payload as { sessionId: string };
          const summary = tracker.getSummary(sessionId);
          return { success: true, data: summary } satisfies IPCResponse;
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown diff action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Diff IPC error:', error);
      return {
        success: false,
        error: { code: 'DIFF_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      } satisfies IPCResponse;
    }
  });
}
