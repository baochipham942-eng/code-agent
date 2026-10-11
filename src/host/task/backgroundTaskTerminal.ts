// ============================================================================
// BackgroundTaskTerminal - run 终态对后台条目的收线（N-RUNINPUT-TOBACKGROUND-OPTION rework）
// ============================================================================
// 2026-10-11 无槽验收：后台任务撞 max-step 上限结束后，面板/侧栏 spinner 永不收线
// （12/22 分钟不落，reload 后依旧）——task_complete 只在收尾文本路径发，失败/取消/
// 中断/撞顶轮没有它。agent_complete / agent_cancelled 是 runFinalizer 对**每种**终态
// 都恰好发一次的锚事件；到点仍是 running 的后台条目 = 没被 task_complete 收口的终态，
// 在这里按记账的 run 级 error（失败/撞顶）或取消语义收线。从 TaskManager 抽出独立
// 模块也是 effective-line 硬限所迫（该文件贴 1000 行门）。

import type { AgentEvent } from '../../shared/contract';
import { resolveBackgroundRunSettlement, settleBackgroundRun } from '../session/backgroundRunSettlement';
import { getBackgroundTaskManager } from '../session/backgroundTaskManager';
import { getSessionManager, notificationService } from '../services';

/** run 级 error 事件的记账（message 展示用、code 优先给 renderer 翻译）。 */
export interface BackgroundRunErrorRecord {
  message?: string;
  code?: string;
}

/**
 * task_complete 的收口（从 TaskManager.persistEventToSession 抽出）：
 * 后台会话 → markCompleted（force 完成通知在 markCompleted 内）；前台保持原普通通知。
 * 子代理的 task_complete（eventKey ≠ sessionId）不触发后台收口。
 */
export async function settleBackgroundOnTaskComplete(
  sessionId: string,
  eventKey: string,
  data: { summary?: string; duration?: number; toolsUsed?: string[] },
): Promise<void> {
  const backgroundManager = getBackgroundTaskManager();
  if (eventKey === sessionId && backgroundManager.isInBackground(sessionId)) {
    await backgroundManager.markCompleted(sessionId, data.summary);
    return;
  }
  const session = await getSessionManager().getSession(sessionId);
  if (session) {
    notificationService.notifyTaskComplete({
      sessionId: session.id,
      sessionTitle: session.title,
      summary: data.summary,
      duration: data.duration ?? 0,
      toolsUsed: data.toolsUsed || [],
    });
  }
}

/** run 级 error 事件记账（非 warning 的 error 事件到达时调用；agent_complete 收线时消费）。 */
export function trackBackgroundRunError(
  errors: Map<string, BackgroundRunErrorRecord>,
  sessionId: string,
  data: AgentEvent['data'],
): void {
  if (!data || typeof data !== 'object') return;
  const { message, code } = data as { message?: unknown; code?: unknown };
  errors.set(sessionId, {
    message: typeof message === 'string' ? message : undefined,
    code: typeof code === 'string' ? code : undefined,
  });
}

/**
 * agent_complete / agent_cancelled 的收线：后台条目仍 running（= 没走 task_complete
 * 收口的终态）→ 失败/撞顶按记账 error 收 markFailed，取消/中断收 markCompleted +
 * USER_CANCELLED 标记。已被 task_complete 收过的条目被 running-guard 挡住，天然幂等。
 */
export async function closeBackgroundRunAtTerminal(
  sessionId: string,
  eventType: 'agent_complete' | 'agent_cancelled',
  errors: Map<string, BackgroundRunErrorRecord>,
): Promise<void> {
  const runError = errors.get(sessionId);
  errors.delete(sessionId);
  const backgroundManager = getBackgroundTaskManager();
  if (!backgroundManager.isInBackground(sessionId) || !backgroundManager.isTaskRunning(sessionId)) {
    return;
  }
  await settleBackgroundRun(backgroundManager, sessionId, resolveBackgroundRunSettlement(
    runError
      ? { status: 'error', errorMessage: runError.message, errorCode: runError.code }
      : { status: 'interrupted' },
  ));
}
