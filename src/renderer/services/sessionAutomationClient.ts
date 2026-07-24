import { IPC_DOMAINS } from '@shared/ipc';
import type {
  SessionAutomationRecord,
  SessionAutomationSessionSummary,
} from '@shared/contract';
import type { ParkedApprovalInboxItem } from '@shared/contract/pendingApproval';
import ipcService from './ipcService';

export const sessionAutomationClient = {
  listBySession(sessionId: string) {
    return ipcService.invokeDomain<SessionAutomationRecord[]>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'listBySession',
      { sessionId },
    );
  },

  summarizeSessions(sessionIds: string[]) {
    return ipcService.invokeDomain<Record<string, SessionAutomationSessionSummary>>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'summarizeSessions',
      { sessionIds },
    );
  },

  getSessionSummary(sessionId: string) {
    return ipcService.invokeDomain<SessionAutomationSessionSummary>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'getSessionSummary',
      { sessionId },
    );
  },

  listPendingReview() {
    return ipcService.invokeDomain<SessionAutomationRecord[]>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'listPendingReview',
      {},
    );
  },

  countPendingReview() {
    return ipcService.invokeDomain<number>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'countPendingReview',
      {},
    );
  },

  listParkedApprovals() {
    return ipcService.invokeDomain<ParkedApprovalInboxItem[]>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'listParkedApprovals',
      {},
    );
  },

  markReviewed(automationId: string) {
    return ipcService.invokeDomain<SessionAutomationRecord | null>(
      IPC_DOMAINS.SESSION_AUTOMATION,
      'markReviewed',
      { automationId },
    );
  },
};

export default sessionAutomationClient;
