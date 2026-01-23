// ============================================================================
// HooksEngine - Dual-channel architecture for context engineering
// ============================================================================
//
// This engine implements a dual-channel hooks system:
// - Observer Channel: Passive hooks that observe and record (parallel, non-blocking)
// - Decision Channel: Active hooks that can block or inject context (serial, can block)
//
// Execution order:
// 1. Run all observers in parallel (fire-and-forget, errors logged but not thrown)
// 2. Run all decision hooks in priority order (serial, can block execution)
//
// ============================================================================

import type {
  HookContext,
  HookResult,
  PlanningHooksConfig,
  PlanningRulesConfig,
} from './types';
import type { PlanManager } from './planManager';
import type { ErrorTracker } from './errorTracker';
import type { FindingsManager } from './findingsManager';
import type {
  ObserverHook,
  DecisionHook,
  HookDecision,
  HookPoint,
  DualChannelConfig,
  AggregatedHookResult,
} from './hooks/types';
import { DEFAULT_DUAL_CHANNEL_CONFIG } from './hooks/types';
import {
  observerHooks,
  getObserversForPoint,
  resetObserverState,
  getActionCount,
} from './hooks/observerHooks';
import {
  createDecisionHooks,
  getDecisionHooksForPoint,
  type DecisionHooksConfig,
} from './hooks/decisionHooks';

// ----------------------------------------------------------------------------
// Legacy Configurations (for backward compatibility)
// ----------------------------------------------------------------------------

const DEFAULT_HOOKS_CONFIG: PlanningHooksConfig = {
  preToolUse: true,
  postToolUse: true,
  onStop: true,
  onError: true,
};

const DEFAULT_RULES_CONFIG: PlanningRulesConfig = {
  actionThreshold: 5,
  errorStrikeLimit: 3,
};

// ----------------------------------------------------------------------------
// HooksEngine
// ----------------------------------------------------------------------------

export class HooksEngine {
  private hooksConfig: PlanningHooksConfig;
  private rulesConfig: PlanningRulesConfig;
  private dualChannelConfig: DualChannelConfig;
  private decisionHooks: Array<{ point: HookPoint; hook: DecisionHook }>;

  constructor(
    private planManager: PlanManager,
    private errorTracker: ErrorTracker,
    private findingsManager: FindingsManager,
    config?: {
      hooks?: Partial<PlanningHooksConfig>;
      rules?: Partial<PlanningRulesConfig>;
      dualChannel?: Partial<DualChannelConfig>;
    }
  ) {
    this.hooksConfig = { ...DEFAULT_HOOKS_CONFIG, ...config?.hooks };
    this.rulesConfig = { ...DEFAULT_RULES_CONFIG, ...config?.rules };
    this.dualChannelConfig = {
      ...DEFAULT_DUAL_CHANNEL_CONFIG,
      ...config?.dualChannel,
    };

    // Initialize decision hooks with dependencies
    const decisionConfig: DecisionHooksConfig = {
      actionThreshold: this.rulesConfig.actionThreshold,
      errorStrikeLimit: this.rulesConfig.errorStrikeLimit,
    };
    this.decisionHooks = createDecisionHooks(
      planManager,
      errorTracker,
      decisionConfig
    );
  }

  // ==========================================================================
  // Main Hook Entry Points
  // ==========================================================================

  /**
   * Session Start Hook
   */
  async onSessionStart(): Promise<HookResult> {
    resetObserverState();
    return this.runHooksForPoint('session_start', {});
  }

  /**
   * Pre-Tool Use Hook
   */
  async preToolUse(context: HookContext): Promise<HookResult> {
    if (!this.hooksConfig.preToolUse) {
      return { shouldContinue: true };
    }
    return this.runHooksForPoint('pre_tool_use', context);
  }

  /**
   * Post-Tool Use Hook
   */
  async postToolUse(context: HookContext): Promise<HookResult> {
    if (!this.hooksConfig.postToolUse) {
      return { shouldContinue: true };
    }

    // Log errors to error tracker
    if (context.toolResult && !context.toolResult.success && context.toolResult.error) {
      await this.errorTracker.log({
        toolName: context.toolName || 'unknown',
        message: context.toolResult.error,
        params: context.toolParams,
      });
    }

    return this.runHooksForPoint('post_tool_use', context);
  }

  /**
   * Stop Hook
   */
  async onStop(): Promise<HookResult> {
    if (!this.hooksConfig.onStop) {
      return { shouldContinue: true };
    }
    return this.runHooksForPoint('on_stop', {});
  }

  /**
   * Error Hook
   */
  async onError(context: HookContext): Promise<HookResult> {
    if (!this.hooksConfig.onError) {
      return { shouldContinue: true };
    }

    // Log error to tracker
    await this.errorTracker.log({
      toolName: context.toolName || 'unknown',
      message: context.error?.message || 'Unknown error',
      stack: context.error?.stack,
      params: context.toolParams,
    });

    return this.runHooksForPoint('on_error', context);
  }

  // ==========================================================================
  // Dual-Channel Execution
  // ==========================================================================

  /**
   * Run all hooks for a given hook point using dual-channel architecture
   */
  private async runHooksForPoint(
    point: HookPoint,
    context: HookContext
  ): Promise<AggregatedHookResult> {
    const result: AggregatedHookResult = {
      shouldContinue: true,
      decisions: [],
      observerErrors: [],
    };

    // Inject current action count into context
    const enrichedContext: HookContext = {
      ...context,
      actionCount: getActionCount(),
    };

    // -----------------------------------------------------------------------
    // Channel 1: Run Observers (parallel, non-blocking)
    // -----------------------------------------------------------------------
    if (this.dualChannelConfig.enableObservers) {
      const observers = getObserversForPoint(point);
      const matchedObservers = observers.filter((o) =>
        o.matcher(enrichedContext)
      );

      if (this.dualChannelConfig.parallelObservers) {
        // Run in parallel with timeout
        const observerPromises = matchedObservers.map((observer) =>
          this.runObserverWithTimeout(observer, enrichedContext)
        );
        const observerResults = await Promise.allSettled(observerPromises);

        // Collect any errors (for logging, not blocking)
        observerResults.forEach((r, i) => {
          if (r.status === 'rejected') {
            result.observerErrors.push({
              hookId: matchedObservers[i].id,
              error: r.reason as Error,
            });
          }
        });
      } else {
        // Run sequentially
        for (const observer of matchedObservers) {
          try {
            await this.runObserverWithTimeout(observer, enrichedContext);
          } catch (error) {
            result.observerErrors.push({
              hookId: observer.id,
              error: error as Error,
            });
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Channel 2: Run Decision Hooks (serial, can block)
    // -----------------------------------------------------------------------
    if (this.dualChannelConfig.enableDecisions) {
      const decisionHooks = getDecisionHooksForPoint(this.decisionHooks, point);
      const matchedDecisions = decisionHooks.filter((d) =>
        d.matcher(enrichedContext)
      );

      let combinedInjectContext = '';

      for (const decisionHook of matchedDecisions) {
        try {
          const decision = await this.runDecisionWithTimeout(
            decisionHook,
            enrichedContext
          );

          result.decisions.push({
            hookId: decisionHook.id,
            decision,
          });

          // Collect inject context
          if (decision.injectContext) {
            combinedInjectContext += decision.injectContext + '\n';
          }

          // Set notification (last one wins)
          if (decision.notification) {
            result.notification = decision.notification;
          }

          // If blocked, stop processing and return
          if (!decision.allow) {
            result.shouldContinue = false;
            break;
          }
        } catch (error) {
          // Decision hook errors are logged but don't block
          console.error(
            `Decision hook ${decisionHook.id} failed:`,
            error
          );
        }
      }

      // Set combined inject context
      if (combinedInjectContext) {
        result.injectContext = combinedInjectContext.trim();
      }
    }

    return result;
  }

  /**
   * Run an observer hook with timeout protection
   */
  private async runObserverWithTimeout(
    observer: ObserverHook,
    context: HookContext
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Observer ${observer.id} timed out`));
      }, this.dualChannelConfig.observerTimeout);

      Promise.resolve(observer.observe(context))
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  /**
   * Run a decision hook with timeout protection
   */
  private async runDecisionWithTimeout(
    decisionHook: DecisionHook,
    context: HookContext
  ): Promise<HookDecision> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // On timeout, allow by default (fail-open)
        resolve({ allow: true, reason: 'Decision hook timed out' });
      }, this.dualChannelConfig.decisionTimeout);

      Promise.resolve(decisionHook.decide(context))
        .then((decision) => {
          clearTimeout(timeout);
          resolve(decision);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  // ==========================================================================
  // Legacy Compatibility Methods
  // ==========================================================================

  /**
   * Reset action counter (legacy method, now handled by observer)
   * @deprecated Use resetObserverState() instead
   */
  resetActionCount(): void {
    resetObserverState();
  }

  /**
   * Get current action count (legacy method)
   * @deprecated Use getActionCount() from observerHooks instead
   */
  getActionCount(): number {
    return getActionCount();
  }

  // ==========================================================================
  // Hook Registration (for custom hooks)
  // ==========================================================================

  /**
   * Register a custom decision hook
   */
  registerDecisionHook(point: HookPoint, hook: DecisionHook): void {
    this.decisionHooks.push({ point, hook });
  }

  /**
   * Get registered decision hooks for testing/inspection
   */
  getRegisteredDecisionHooks(): Array<{
    point: HookPoint;
    hook: DecisionHook;
  }> {
    return [...this.decisionHooks];
  }
}
