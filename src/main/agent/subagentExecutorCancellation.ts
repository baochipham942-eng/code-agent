// ============================================================================
// Subagent Executor Cancellation Helpers
// ============================================================================

import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
import { createChildAbortController, createTimedAbortController } from './shutdownProtocol';

const DEFAULT_TIMEOUT_MS = 90_000;

const DEFAULT_EXECUTION_TIMEOUT = new Map<string, number>([
  ['Code Explore Agent', 60_000],
  ['Web Search Agent', 60_000],
  ['Document Reader Agent', 45_000],
  ['Code Reviewer', 90_000],
  ['视觉理解 Agent', 60_000],
  ['Coder', 120_000],
  ['Debugger', 120_000],
  ['Test Engineer', 120_000],
  ['Code Refactorer', 90_000],
  ['DevOps Engineer', 90_000],
  ['Technical Writer', 60_000],
  ['Plan Agent', 90_000],
  ['Software Architect', 90_000],
  ['General Purpose Agent', 120_000],
  ['Bash Executor Agent', 60_000],
  ['MCP Connector Agent', 90_000],
  ['视觉处理 Agent', 90_000],
]);

export interface SubagentCancellationLifecycle {
  effectiveController: AbortController;
  effectiveSignal: AbortSignal;
  cleanupTimer: () => void;
  markProgress: () => void;
  stopIdleWatchdog: () => void;
}

export function getSubagentExecutionTimeout(agentName: string, overrideMs?: number): number {
  return overrideMs || DEFAULT_EXECUTION_TIMEOUT.get(agentName) || DEFAULT_TIMEOUT_MS;
}

export function createSubagentCancellationLifecycle(options: {
  agentName: string;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  onIdleTimeout?: (idleMs: number) => void;
}): SubagentCancellationLifecycle {
  const { agentName, timeoutMs, parentSignal, onIdleTimeout } = options;
  const { controller: timeoutController, cleanup: cleanupTimer } = createTimedAbortController(
    timeoutMs,
    { label: agentName },
  );

  const effectiveController = parentSignal
    ? (() => {
        const parentController = new AbortController();
        parentSignal.addEventListener('abort', () => {
          parentController.abort(parentSignal.reason);
        }, { once: true });
        timeoutController.signal.addEventListener('abort', () => {
          parentController.abort(timeoutController.signal.reason);
        }, { once: true });
        return createChildAbortController(parentController);
      })()
    : timeoutController;
  const effectiveSignal = effectiveController.signal;

  let lastProgressAt = Date.now();
  const markProgress = (): void => {
    lastProgressAt = Date.now();
  };
  const idleWatchdog = setInterval(() => {
    if (effectiveSignal.aborted) return;
    const idle = Date.now() - lastProgressAt;
    if (idle > CANCELLATION_TIMEOUTS.IDLE_TIMEOUT) {
      onIdleTimeout?.(idle);
      effectiveController.abort('idle-timeout');
    }
  }, CANCELLATION_TIMEOUTS.IDLE_CHECK_INTERVAL);
  (idleWatchdog as { unref?: () => void }).unref?.();

  return {
    effectiveController,
    effectiveSignal,
    cleanupTimer,
    markProgress,
    stopIdleWatchdog: () => clearInterval(idleWatchdog),
  };
}
