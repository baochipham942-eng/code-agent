// ============================================================================
// Subagent Executor Cancellation Helpers
// ============================================================================

import { CANCELLATION_TIMEOUTS, SUBAGENT_EXECUTION_TIMEOUTS } from '../../shared/constants';
import { SUBAGENT_IDLE } from '../../shared/constants/agent';
import { join as pathJoin } from 'path';
import { createChildAbortController, createTimedAbortController, initiateShutdown } from './shutdownProtocol';
import { getUserDataPath } from '../platform/appPaths';
import { captureWorkspacePatch } from '../services/checkpoint/taskPatchService';

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

/**
 * 取消收口的 flush 阶段（N-SUBAGENT-ZEROTOOLS 返修：为 max-lines 硬限从
 * executor 拆出）：four-phase shutdown + partial transcript 落盘 + 工作区 patch 抢救。
 * R5 — agentPromise 传 Promise.resolve()：这是运行中 executor 自己的循环，grace
 * 阶段不能等自己；abort 已传播到 inference/tools，它们的清理并行跑。
 */
export async function flushSubagentCancellation(options: {
  agentName: string;
  agentTask: { id: string; saveToDisk(sessionDir: string): Promise<unknown> };
  controller: AbortController;
  sessionId: string;
  worktreePath?: string;
  cwd?: string;
  logger: { warn(message: string, error?: unknown): void };
}): Promise<void> {
  const { agentName, agentTask, controller, sessionId, worktreePath, cwd, logger } = options;
  // sessionDir convention: <userDataPath>/sessions/<sessionId>.
  // saveToDisk creates the agent subdir itself; we just hand it the session root.
  const sessionDir = pathJoin(getUserDataPath(), 'sessions', sessionId);
  try {
    await initiateShutdown(controller, Promise.resolve(), {
      gracePeriodMs: CANCELLATION_TIMEOUTS.GRACEFUL_SHUTDOWN_GRACE,
      label: `${agentName}:${agentTask.id}`,
      onFlush: async () => {
        try {
          await agentTask.saveToDisk(sessionDir);
        } catch (err) {
          logger.warn(`[${agentName}] saveToDisk failed during flush`, err);
        }
        // 取消时把工作目录的文件改动抢救成 patch（saveToDisk 只存 transcript）。
        // 有 worktree 用 worktree 路径，否则用会话工作目录。best-effort 不阻塞取消。
        try {
          const patchDir = worktreePath || cwd;
          if (patchDir) {
            await captureWorkspacePatch(patchDir, agentTask.id, 'cancel');
          }
        } catch (err) {
          logger.warn(`[${agentName}] captureWorkspacePatch failed during flush`, err);
        }
      },
    });
  } catch (err) {
    logger.warn(`[${agentName}] initiateShutdown threw`, err);
  }
}
