import { getWakeService } from './wakeService';
import { getSessionManager } from '../infra/sessionManager';
import { generateMessageId } from '../../../shared/utils/id';
import { createLogger } from '../infra/logger';
import type { AgentRunOptions } from '../../research/types';

const logger = createLogger('WakeUserReturn');

/** Both ordinary messages and in-flight user redirects pass through this boundary. */
export async function cancelTimeWakesOnUserReturn(
  sessionId: string,
  options?: Pick<AgentRunOptions, 'inputSource' | 'historyVisibility' | 'inputHistoryVisibility'>,
): Promise<void> {
  if (options?.inputSource === 'automation' || options?.historyVisibility === 'meta'
    || options?.inputHistoryVisibility === 'meta') return;
  try {
    const count = getWakeService().cancelForSession(sessionId, 'time');
    if (count === 0) return;
    await getSessionManager().addMessageToSession(sessionId, {
      id: generateMessageId(), role: 'system', timestamp: Date.now(),
      content: `你已回来，已取消 ${count} 个定时唤醒；等待任务或事件的安排继续保留。`,
    });
  } catch (error) {
    logger.warn('Failed to cancel or record time wakes on user return', { sessionId, error });
  }
}
