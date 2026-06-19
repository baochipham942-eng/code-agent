import { IPC_DOMAINS } from '@shared/ipc';
import type {
  SessionAutomationRecord,
  SessionAutomationSessionSummary,
} from '@shared/contract';
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
};

export default sessionAutomationClient;
