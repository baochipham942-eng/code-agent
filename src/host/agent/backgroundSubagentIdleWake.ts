import { SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../shared/constants';
import type { MessageMetadata } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { formatSystemReminderForCompletions, type SubagentCompletionRecord } from './subagentCompletionNotification';

const logger = createLogger('BackgroundSubagentIdleWake');

interface PendingWakeBatch {
  timer: ReturnType<typeof setTimeout>;
}

const pendingWakeBySession = new Map<string, PendingWakeBatch>();

function wakeKey(record: SubagentCompletionRecord): string | undefined {
  return record.sessionId;
}

async function flushWake(sessionId: string): Promise<void> {
  const batch = pendingWakeBySession.get(sessionId);
  if (!batch) return;
  pendingWakeBySession.delete(sessionId);

  try {
    const { getTaskManager } = await import('../task/TaskManager');
    const taskManager = getTaskManager();
    const state = taskManager.getSessionState(sessionId);
    if (state.status !== 'idle') {
      // 父会话在跑：不消费队列，交给工具结果提醒路径投递（单一消费点防双投递）。
      return;
    }

    const { getBackgroundSubagentRegistry } = await import('./backgroundSubagentRegistry');
    const records = getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId });
    const content = formatSystemReminderForCompletions(records);
    if (!content) return;

    const messageMetadata: MessageMetadata = {
      automation: {
        automationId: `background-subagent:${sessionId}`,
        automationType: 'role_wake',
        event: 'stage_ready',
        sourceSessionId: sessionId,
        status: 'running',
        title: 'Background subagent completed',
      },
    };

    await taskManager.startTask(
      sessionId,
      content,
      undefined,
      {
        mode: 'normal',
        historyVisibility: 'meta',
        maxIterations: 1,
      },
      messageMetadata,
      `background-subagent:${sessionId}:${Date.now()}`,
    );
  } catch (error) {
    logger.warn('Failed to wake idle parent session for background subagent completion', {
      sessionId,
      error: String(error),
    });
  }
}

export function scheduleBackgroundSubagentIdleWake(record: SubagentCompletionRecord): void {
  const sessionId = wakeKey(record);
  if (!sessionId) return;

  if (pendingWakeBySession.has(sessionId)) return;

  const timer = setTimeout(() => {
    void flushWake(sessionId);
  }, SUBAGENT_COMPLETION_NOTIFICATIONS.IDLE_WAKE_DEBOUNCE);
  pendingWakeBySession.set(sessionId, { timer });
}

