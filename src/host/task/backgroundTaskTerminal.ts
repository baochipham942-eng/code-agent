// ============================================================================
// BackgroundTaskTerminal - run 终态对后台条目的收线（N-RUNINPUT-TOBACKGROUND-OPTION rework）
// ============================================================================
// 2026-10-11 无槽验收：后台任务撞 max-step 上限结束后，面板/侧栏 spinner 永不收线
// （12/22 分钟不落，reload 后依旧）——task_complete 只在收尾文本路径发，失败/取消/
// 中断/撞顶轮没有它。agent_complete / agent_cancelled 是 runFinalizer 对**每种**终态
// 都恰好发一次的锚事件；到点仍是 running 的后台条目 = 没被 task_complete 收口的终态，
// 在这里收线。从 TaskManager 抽出独立模块也是 effective-line 硬限所迫（该文件贴
// 1000 行门）。
// 2026-10-14 r4：只从显式终态信号分类，不再拿「缺信号」猜结局——research/auto-agent
// 成功轮只发 agent_complete（无 task_complete 无 error），旧表把它猜成「已停止」；
// 中段可恢复 error（terminal:false / warning 级）不再单独决定失败。判据与
// createTerminalEventTracker（durableRunTerminal）同形：isTerminalAgentError。

import type { AgentEvent } from '../../shared/contract';
import { isTerminalAgentError } from '../../shared/utils/agentErrorClassification';
import { resolveBackgroundRunSettlement, settleBackgroundRun } from '../session/backgroundRunSettlement';
import { getBackgroundTaskManager } from '../session/backgroundTaskManager';
import { getSessionManager, notificationService } from '../services';

/** run 级终态 error 事件的记账（message 展示用、code 优先给 renderer 翻译）。 */
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

/**
 * run 级终态 error 事件记账（error 事件到达时调用；agent_complete 收线时消费）。
 * 只记终态 error（isTerminalAgentError）：中段可恢复 error（terminal:false / warning
 * 级，run 会继续）不进账——进了就会在 agent_complete 收线时把成功轮误报成失败（r4）。
 */
export function trackBackgroundRunTerminalError(
  errors: Map<string, BackgroundRunErrorRecord>,
  sessionId: string,
  data: AgentEvent['data'],
): void {
  if (!data || typeof data !== 'object' || !isTerminalAgentError(data)) return;
  const { message, code } = data as { message?: unknown; code?: unknown };
  errors.set(sessionId, {
    message: typeof message === 'string' ? message : undefined,
    code: typeof code === 'string' ? code : undefined,
  });
}

/**
 * agent_complete / agent_cancelled 的收线，决策表与 web 直连轮（agent.ts 的
 * finalStatus = runCancelled ? interrupted : hadTerminalError ? error : completed）
 * 同一份分类，优先级也一致：
 * 1. agent_cancelled（用户取消压过一切，含此前有终态 error 记账的场合——r2）；
 * 2. 有终态 error 记账（isTerminalAgentError 筛过）→ markFailed（失败/撞顶）；
 * 3. 其余 agent_complete（有无 task_complete、有无中段可恢复 error 均不论）→
 *    markCompleted，成功通知由 markCompleted 内发（research/auto-agent 成功形状，r4）。
 * 已被 task_complete 收过的条目被 running-guard 挡住，天然幂等。
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
    eventType === 'agent_cancelled'
      ? { status: 'interrupted' }
      : runError
        ? { status: 'error', errorMessage: runError.message, errorCode: runError.code }
        : { status: 'completed' },
  ));
}

/**
 * run promise 整体 reject（事件流没来得及收线的失败，如起跑前异常）的兜底收线：
 * 决策表第 2 条的「或 run promise rejected」腿。markFailed 自带 running-guard，
 * 与事件流收线互为幂等；用户取消在调用方（两个 run 入口的 catch）更早的取消分支
 * 返回，不会走到这里。
 */
export function settleBackgroundRunOnRejection(sessionId: string, errorMessage: string): void {
  const backgroundManager = getBackgroundTaskManager();
  if (!backgroundManager.isInBackground(sessionId) || !backgroundManager.isTaskRunning(sessionId)) return;
  backgroundManager.markFailed(
    sessionId,
    resolveBackgroundRunSettlement({ status: 'error', errorMessage }).message,
  );
}
