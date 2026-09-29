// ============================================================================
// Durable Recovery「停靠等待确认」系统通知
// 从 webServer.ts 抽出（webServer 无法直接进单测，参照 queuedInputStartupSweep 的做法）：
// 过滤停靠类恢复结果，按用户语言（ui.language）投递 needs_input 通知。
// ============================================================================

import { getConfigService } from '../host/services/core/configService';
import {
  getDurableResumeNotificationText,
  type DurableResumeNotificationLocale,
} from '../shared/i18n/durableResumeNotification';
import type { DurableRecoveryDispatchResult } from '../host/runtime/durableRecoveryDispatcher';

/** 通知文案语言跟随用户设置（ui.language）；读取失败按中文兜底，通知不许把恢复路径炸掉。 */
function readNotificationLocale(): DurableResumeNotificationLocale {
  try {
    return getConfigService().getSettings().ui.language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export interface DurableRecoveryWaitingNotifierDeps {
  getDurableEnvelope(runId: string): { sessionId: string } | undefined;
  getSession(sessionId: string): Promise<{ id: string; title: string } | null>;
  notifyNeedsInput(data: { sessionId: string; title: string; body: string }): void;
  onError(error: unknown): void;
}

export function notifyDurableRecoveryWaiting(
  results: DurableRecoveryDispatchResult[],
  deps: DurableRecoveryWaitingNotifierDeps,
): void {
  const waitingRunIds = new Set(results
    .filter((result) => ['restore_same_approval', 'waiting_for_approval', 'auto_agent_waiting'].includes(result.reason))
    .map((result) => result.runId));
  const text = getDurableResumeNotificationText(readNotificationLocale());
  for (const runId of waitingRunIds) {
    const envelope = deps.getDurableEnvelope(runId);
    if (!envelope) continue;
    void deps.getSession(envelope.sessionId).then((session) => {
      if (!session) return;
      deps.notifyNeedsInput({
        sessionId: session.id,
        title: session.title || text.untitledSession,
        body: text.waitingBody,
      });
    }).catch((error: unknown) => deps.onError(error));
  }
}
