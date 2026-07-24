// ============================================================================
// Session Automation IPC
// ============================================================================

import { ipcHost } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getSessionAutomationService } from '../services/sessionAutomation';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionAutomationIPC');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(source: unknown, field: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

function getStringArray(source: unknown, field: string): string[] {
  if (!isRecord(source)) return [];
  const value = source[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function registerSessionAutomationHandlers(): void {
  ipcHost.handle(IPC_DOMAINS.SESSION_AUTOMATION, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const service = getSessionAutomationService();
    try {
      switch (request.action) {
        case 'listBySession': {
          const sessionId = getString(request.payload, 'sessionId');
          if (!sessionId) throw new Error('缺少 sessionId');
          return { success: true, data: service.listBySessionIds([sessionId]) } satisfies IPCResponse;
        }
        case 'summarizeSessions': {
          const sessionIds = getStringArray(request.payload, 'sessionIds');
          return { success: true, data: service.summarizeSessions(sessionIds) } satisfies IPCResponse;
        }
        case 'getSessionSummary': {
          const sessionId = getString(request.payload, 'sessionId');
          if (!sessionId) throw new Error('缺少 sessionId');
          return { success: true, data: service.summarizeSessions([sessionId])[sessionId] } satisfies IPCResponse;
        }
        case 'listPendingReview': {
          return { success: true, data: service.listPendingReview() } satisfies IPCResponse;
        }
        case 'listParkedApprovals': {
          return { success: true, data: service.listParkedApprovals() } satisfies IPCResponse;
        }
        case 'countPendingReview': {
          return { success: true, data: service.countPendingReview() } satisfies IPCResponse;
        }
        case 'markReviewed': {
          const automationId = getString(request.payload, 'automationId');
          if (!automationId) throw new Error('缺少 automationId');
          return { success: true, data: service.markReviewed(automationId) } satisfies IPCResponse;
        }
        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown session automation action: ${request.action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Session automation IPC error:', error);
      return {
        success: false,
        error: { code: 'SESSION_AUTOMATION_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      } satisfies IPCResponse;
    }
  });
}
