// ============================================================================
// Circuit Breaker - Prevents infinite tool failure loops
// ============================================================================

import type { CircuitBreakerState } from '../loopTypes';
import type { ErrorCategory } from '../../../shared/contract/telemetry';
import { TOOL_CIRCUIT_BREAKER } from '../../../shared/constants/circuitBreaker';
import { classifyError } from '../../telemetry/telemetryCollectorInternal';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector';

const logger = createLogger('CircuitBreaker');

const TRIPPABLE_ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set(
  TOOL_CIRCUIT_BREAKER.TRIPPABLE_ERROR_CATEGORIES
);

/**
 * 只有基础设施类失败（网络 / 数据库 / 5xx / 依赖与进程资源类）计入熔断计数；
 * 业务可预期失败（命令非零退出、参数校验失败、断言失败、文件不存在等）是模型
 * 可修正的正常试错，不计数、不熔断，照常回喂。
 * 例外：工具执行抛出的未识别异常（classifyError 落 unknown）来自 exception
 * 兜底路径，不是业务结果，保守起见仍计数，防无限重试卡死会话。
 */
function isTrippableFailure(errorMessage: string, countUnknown: boolean): boolean {
  const category = classifyError(errorMessage);
  if (TRIPPABLE_ERROR_CATEGORIES.has(category)) return true;
  return countUnknown && category === 'unknown';
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Maximum consecutive failures before tripping */
  maxConsecutiveFailures: number;
  /** Cooldown period in ms before resetting (optional) */
  cooldownMs?: number;
}

/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxConsecutiveFailures: TOOL_CIRCUIT_BREAKER.MAX_CONSECUTIVE_FAILURES,
  cooldownMs: undefined, // No auto-reset by default
};

/**
 * Circuit Breaker - Prevents runaway failure loops
 *
 * When consecutive infrastructure-class tool failures (network, database,
 * 5xx, missing dependencies) repeat, the circuit breaker trips to prevent
 * infinite loops and resource waste. Business-expected failures (non-zero
 * command exits, argument validation, assertions, missing files) never
 * trip it — they are normal model trial-and-error and stay fed back.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    this.state = {
      consecutiveFailures: 0,
      isTripped: false,
    };
  }

  /**
   * Record a tool call success
   * Resets the consecutive failure counter
   */
  recordSuccess(): void {
    if (this.state.consecutiveFailures > 0) {
      logger.debug(
        `Tool succeeded, resetting consecutive failure counter (was ${this.state.consecutiveFailures})`
      );
    }
    this.state.consecutiveFailures = 0;
  }

  /**
   * Record a tool call failure
   * Only infrastructure-class failures increment the consecutive failure
   * counter; business-expected failures are fed back to the model as usual
   * without affecting the counter.
   *
   * @param error - Error message or object
   * @param options.countUnknown - exception 兜底路径传 true：无法分类的异常
   *   （classifyError 落 unknown）保守计入，防未识别异常无限重试。工具结果
   *   通道（业务失败也走这里）用默认 false，unknown 一律视为业务失败。
   * @returns true if the circuit breaker is now tripped
   */
  recordFailure(error?: string | Error, options?: { countUnknown?: boolean }): boolean {
    const errorMsg = error instanceof Error ? error.message : error || '';

    if (!isTrippableFailure(errorMsg, options?.countUnknown === true)) {
      logger.debug(
        `Business-class tool failure (not counted toward circuit breaker): ${errorMsg.slice(0, 120)}`
      );
      return false;
    }

    this.state.consecutiveFailures++;

    logger.debug(
      `Consecutive tool failures: ${this.state.consecutiveFailures}/${this.config.maxConsecutiveFailures}`
    );

    if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.trip(error);
      return true;
    }

    return false;
  }

  /**
   * Trip the circuit breaker
   */
  private trip(error?: string | Error): void {
    if (this.state.isTripped) return;

    this.state.isTripped = true;
    this.state.lastTripTime = Date.now();

    const errorMsg = error instanceof Error ? error.message : error || 'Unknown error';

    logger.error(
      `Circuit breaker tripped! ${this.state.consecutiveFailures} consecutive failures. Last error: ${errorMsg}`
    );

    logCollector.agent(
      'ERROR',
      `Circuit breaker tripped after ${this.state.consecutiveFailures} consecutive tool failures`
    );
  }

  /**
   * Check if the circuit breaker is tripped
   */
  isTripped(): boolean {
    // Auto-reset if cooldown has passed
    if (this.state.isTripped && this.config.cooldownMs && this.state.lastTripTime) {
      const elapsed = Date.now() - this.state.lastTripTime;
      if (elapsed >= this.config.cooldownMs) {
        this.reset();
        return false;
      }
    }
    return this.state.isTripped;
  }

  /**
   * Reset the circuit breaker
   * Typically called after user intervention or session restart
   */
  reset(): void {
    this.state = {
      consecutiveFailures: 0,
      isTripped: false,
    };
    logger.info('Circuit breaker reset');
  }

  /**
   * Get current state
   */
  getState(): Readonly<CircuitBreakerState> {
    return { ...this.state };
  }

  /**
   * Get the failure count
   */
  getFailureCount(): number {
    return this.state.consecutiveFailures;
  }

  /**
   * Generate warning message for the model
   */
  generateWarningMessage(lastError?: string): string {
    return (
      `<circuit-breaker-tripped>\n` +
      `🛑 CRITICAL ERROR: ${this.state.consecutiveFailures} consecutive infrastructure-class tool calls have FAILED.\n\n` +
      (lastError ? `The last error was: ${lastError}\n\n` : '') +
      `You MUST:\n` +
      `1. STOP calling tools immediately\n` +
      `2. Report this error to the user clearly\n` +
      `3. Explain what you were trying to do and why it failed\n` +
      `4. Ask the user for guidance on how to proceed\n\n` +
      `DO NOT continue attempting tool calls until the user responds.\n` +
      `</circuit-breaker-tripped>`
    );
  }

  /**
   * Generate user-facing error message
   */
  generateUserErrorMessage(lastError?: string): string {
    return (
      `连续 ${this.state.consecutiveFailures} 次基础设施类工具调用失败，已触发熔断机制。` +
      (lastError ? `最后错误: ${lastError}` : '')
    );
  }
}

/**
 * Create a new circuit breaker instance
 */
export function createCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(config);
}
