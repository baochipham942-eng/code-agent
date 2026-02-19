// ============================================================================
// Shutdown Protocol - 优雅关闭协议
// ============================================================================
// Agent 超时时不再暴力中断，改为四阶段关闭：
// Phase 1: Signal    — abortController.abort('timeout')
// Phase 2: Grace     — 等待当前工具完成（默认 5 秒）
// Phase 3: Flush     — 通过 TeamManager 持久化 findings
// Phase 4: Force     — 返回 partial results
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('ShutdownProtocol');

// ============================================================================
// Types
// ============================================================================

export interface ShutdownOptions {
  /** Grace period in milliseconds (default 5000) */
  gracePeriodMs?: number;
  /** Flush handler — called during Phase 3 to persist state */
  onFlush?: () => Promise<void>;
  /** Label for logging */
  label?: string;
}

export interface ShutdownResult {
  /** Whether the agent completed within the grace period */
  graceful: boolean;
  /** Which phase ended the shutdown */
  phase: 'grace' | 'flush' | 'force';
  /** Partial output collected before shutdown */
  partialOutput?: string;
  /** Duration of the shutdown process */
  durationMs: number;
}

// ============================================================================
// Shutdown Protocol
// ============================================================================

/**
 * Initiate a graceful shutdown for an agent.
 *
 * @param abortController - The agent's AbortController to signal
 * @param agentPromise - The running agent's promise (resolves when agent finishes)
 * @param options - Shutdown configuration
 */
export async function initiateShutdown(
  abortController: AbortController,
  agentPromise: Promise<unknown>,
  options: ShutdownOptions = {}
): Promise<ShutdownResult> {
  const {
    gracePeriodMs = 5000,
    onFlush,
    label = 'agent',
  } = options;

  const startTime = Date.now();

  // Phase 1: Signal
  logger.info(`[${label}] Phase 1: Signaling abort`);
  abortController.abort('timeout');

  // Phase 2: Grace — wait for the agent to finish within grace period
  logger.info(`[${label}] Phase 2: Grace period (${gracePeriodMs}ms)`);
  const graceful = await raceTimeout(agentPromise, gracePeriodMs);

  if (graceful) {
    logger.info(`[${label}] Agent completed within grace period`);

    // Phase 3: Flush even on graceful completion
    if (onFlush) {
      try {
        await onFlush();
        logger.info(`[${label}] Phase 3: Flush completed`);
      } catch (err) {
        logger.warn(`[${label}] Phase 3: Flush failed`, err);
      }
    }

    return {
      graceful: true,
      phase: 'grace',
      durationMs: Date.now() - startTime,
    };
  }

  // Phase 3: Flush — persist state before force exit
  logger.info(`[${label}] Phase 3: Flushing state`);
  if (onFlush) {
    try {
      // Give flush a limited time too (2 seconds)
      const flushed = await raceTimeout(onFlush(), 2000);
      if (flushed) {
        logger.info(`[${label}] Flush completed`);
      } else {
        logger.warn(`[${label}] Flush timed out`);
      }
    } catch (err) {
      logger.warn(`[${label}] Flush failed`, err);
    }
  }

  // Phase 4: Force — return partial results
  logger.info(`[${label}] Phase 4: Force return`);
  return {
    graceful: false,
    phase: 'force',
    durationMs: Date.now() - startTime,
  };
}

/**
 * Create an AbortController that automatically aborts after a timeout,
 * using the shutdown protocol instead of immediate termination.
 */
export function createTimedAbortController(
  timeoutMs: number,
  options?: ShutdownOptions
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      logger.info(`[${options?.label || 'agent'}] Timeout reached (${timeoutMs}ms), aborting`);
      controller.abort('timeout');
    }
  }, timeoutMs);

  const cleanup = () => clearTimeout(timer);

  return { controller, cleanup };
}

/**
 * Combine multiple abort signals into one.
 * The combined signal aborts when any source signal aborts.
 */
export function combineAbortSignals(...signals: AbortSignal[]): AbortController {
  const combined = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      combined.abort(signal.reason);
      return combined;
    }
    signal.addEventListener('abort', () => {
      if (!combined.signal.aborted) {
        combined.abort(signal.reason);
      }
    }, { once: true });
  }

  return combined;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Race a promise against a timeout. Returns true if the promise resolves
 * before the timeout, false otherwise.
 */
async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise
      .then(() => {
        clearTimeout(timer);
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(true); // Settled (even with error) counts as completed
      });
  });
}
