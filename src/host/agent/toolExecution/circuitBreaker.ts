// ============================================================================
// Circuit Breaker - Prevents infinite tool failure loops
// ============================================================================

import type { CircuitBreakerState } from '../loopTypes';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector';

const logger = createLogger('CircuitBreaker');

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
  maxConsecutiveFailures: 5,
  cooldownMs: undefined, // No auto-reset by default
};

/**
 * Circuit Breaker - Prevents runaway failure loops
 *
 * When consecutive tool calls fail repeatedly, the circuit breaker trips
 * to prevent infinite loops and resource waste.
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
   * Increments the consecutive failure counter and trips if threshold reached
   *
   * @param error - Error message or object
   * @returns true if the circuit breaker is now tripped
   */
  recordFailure(error?: string | Error): boolean {
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
      `🛑 CRITICAL ERROR: ${this.state.consecutiveFailures} consecutive tool calls have FAILED.\n\n` +
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
      `连续 ${this.state.consecutiveFailures} 次工具调用失败，已触发熔断机制。` +
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
