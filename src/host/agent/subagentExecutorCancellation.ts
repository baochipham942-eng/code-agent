// ============================================================================
// Subagent Executor Cancellation Helpers
// ============================================================================

import { CANCELLATION_TIMEOUTS, SUBAGENT_EXECUTION_TIMEOUTS } from '../../shared/constants';
import { SUBAGENT_IDLE } from '../../shared/constants/agent';
import { createChildAbortController, createTimedAbortController } from './shutdownProtocol';

const DEFAULT_TIMEOUT_MS = SUBAGENT_EXECUTION_TIMEOUTS.ROLE_EXECUTION_MINIMUM;

export interface SubagentCancellationLifecycle {
  effectiveController: AbortController;
  effectiveSignal: AbortSignal;
  cleanupTimer: () => void;
  markProgress: () => void;
  markRequestStart: () => void;
  markRequestEnd: () => void;
  markToolStart: () => void;
  markToolEnd: () => void;
  stopIdleWatchdog: () => void;
}

export function getSubagentExecutionTimeout(agentName: string, overrideMs?: number): number {
  return overrideMs || DEFAULT_TIMEOUT_MS;
}

export function getChildSubagentExecutionTimeout(
  agentName: string,
  overrideMs?: number,
  parentWindow?: {
    parentStartedAt?: number;
    parentTimeoutMs?: number;
    now?: number;
  },
): number {
  const roleTimeout = getSubagentExecutionTimeout(agentName, overrideMs);
  if (
    !parentWindow
    || typeof parentWindow.parentStartedAt !== 'number'
    || typeof parentWindow.parentTimeoutMs !== 'number'
  ) {
    return roleTimeout;
  }

  const now = parentWindow.now ?? Date.now();
  const parentRemainingMs = Math.max(
    0,
    parentWindow.parentStartedAt + parentWindow.parentTimeoutMs - now,
  );
  return Math.min(roleTimeout, Math.floor(parentRemainingMs * 0.8));
}

// idle 阈值必须 < 总执行预算，否则 idle 看门狗永远来不及在总超时前触发（旧 bug：IDLE_TIMEOUT=120s >
// 默认子代理预算 90s = 死配置，一次推理挂死必跑满总预算）。取 min(IDLE_TIMEOUT, budget*0.9)：既低于
// 总预算成为有意义的"长时间无进展"兜底，又给 per-request 超时+重试（约 budget/2 + 一次重发）留出完成空间。
export function getSubagentIdleTimeout(timeoutMs: number, inTool = false): number {
  return Math.min(inTool ? SUBAGENT_IDLE.IN_TOOL_MS : SUBAGENT_IDLE.IDLE_MS, Math.floor(timeoutMs * 0.9));
}

export function createSubagentCancellationLifecycle(options: {
  agentName: string;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  onIdleTimeout?: (idleMs: number) => void;
  onIdleNudge?: () => void;
  initiallyInTool?: boolean;
}): SubagentCancellationLifecycle {
  const { agentName, timeoutMs, parentSignal, onIdleTimeout } = options;
  const { controller: timeoutController, cleanup: cleanupTimer } = createTimedAbortController(
    timeoutMs,
    { label: agentName },
  );

  const effectiveController = createChildAbortController(timeoutController);
  const onParentAbort = () => effectiveController.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();
  const effectiveSignal = effectiveController.signal;

  let lastProgressAt = Date.now();
  let requestInFlight = false;
  let toolsInFlight = options.initiallyInTool ? 1 : 0;
  let graceStartedAt: number | undefined;
  const markProgress = (): void => {
    lastProgressAt = Date.now();
    graceStartedAt = undefined;
  };
  const markRequestStart = (): void => {
    requestInFlight = true;
  };
  const markRequestEnd = (): void => {
    requestInFlight = false;
    markProgress();
  };
  const markToolStart = (): void => { toolsInFlight++; markProgress(); };
  const markToolEnd = (): void => { toolsInFlight = Math.max(0, toolsInFlight - 1); markProgress(); };
  const idleWatchdog = setInterval(() => {
    if (effectiveSignal.aborted) return;
    // 请求在途 ≠ idle：在途另有 per-request 超时与总预算兜底
    if (requestInFlight) return;
    const idle = Date.now() - lastProgressAt;
    if (idle > getSubagentIdleTimeout(timeoutMs, toolsInFlight > 0)) {
      if (graceStartedAt === undefined) {
        graceStartedAt = Date.now();
        options.onIdleNudge?.();
        return;
      }
      if (Date.now() - graceStartedAt < SUBAGENT_IDLE.GRACE_MS) return;
      onIdleTimeout?.(idle);
      effectiveController.abort('idle-timeout');
    }
  }, CANCELLATION_TIMEOUTS.IDLE_CHECK_INTERVAL);
  (idleWatchdog as { unref?: () => void }).unref?.();

  return {
    effectiveController,
    effectiveSignal,
    cleanupTimer: () => {
      cleanupTimer();
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
    markProgress,
    markRequestStart,
    markRequestEnd,
    markToolStart,
    markToolEnd,
    stopIdleWatchdog: () => clearInterval(idleWatchdog),
  };
}
