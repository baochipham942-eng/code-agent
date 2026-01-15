// ============================================================================
// HooksEngine - Implements Manus-style hooks for context engineering
// ============================================================================

import type {
  HookContext,
  HookResult,
  TaskPlan,
  TaskPhase,
  TaskStep,
  PlanningHooksConfig,
  PlanningRulesConfig,
} from './types';
import type { PlanManager } from './PlanManager';
import type { ErrorTracker } from './ErrorTracker';
import type { FindingsManager } from './FindingsManager';

// ----------------------------------------------------------------------------
// Default Configurations
// ----------------------------------------------------------------------------

const DEFAULT_HOOKS_CONFIG: PlanningHooksConfig = {
  preToolUse: true,
  postToolUse: true,
  onStop: true,
  onError: true,
};

const DEFAULT_RULES_CONFIG: PlanningRulesConfig = {
  actionThreshold: 2,  // 2-Action Rule
  errorStrikeLimit: 3, // 3-Strike Rule
};

// ----------------------------------------------------------------------------
// Critical Tools
// ----------------------------------------------------------------------------

const CRITICAL_TOOLS = ['write_file', 'edit_file', 'bash'];
const VIEW_TOOLS = ['read_file', 'glob', 'grep', 'list_directory', 'web_fetch'];
const WRITE_TOOLS = ['write_file', 'edit_file'];

// ----------------------------------------------------------------------------
// HooksEngine
// ----------------------------------------------------------------------------

export class HooksEngine {
  private actionCount: number = 0;
  private hooksConfig: PlanningHooksConfig;
  private rulesConfig: PlanningRulesConfig;

  constructor(
    private planManager: PlanManager,
    private errorTracker: ErrorTracker,
    private findingsManager: FindingsManager,
    config?: {
      hooks?: Partial<PlanningHooksConfig>;
      rules?: Partial<PlanningRulesConfig>;
    }
  ) {
    this.hooksConfig = { ...DEFAULT_HOOKS_CONFIG, ...config?.hooks };
    this.rulesConfig = { ...DEFAULT_RULES_CONFIG, ...config?.rules };
  }

  // ==========================================================================
  // Hook Entry Points
  // ==========================================================================

  /**
   * Session Start Hook
   * - Check for existing incomplete plan
   * - Reset action counter
   */
  async onSessionStart(): Promise<HookResult> {
    this.actionCount = 0;

    const existingPlan = await this.planManager.read();

    if (existingPlan && !this.planManager.isComplete()) {
      const current = this.planManager.getCurrentTask();
      return {
        shouldContinue: true,
        injectContext: this.formatPlanReminder(existingPlan, current),
        notification: `Found existing plan: ${existingPlan.title} (${existingPlan.metadata.completedSteps}/${existingPlan.metadata.totalSteps} completed)`,
      };
    }

    return { shouldContinue: true };
  }

  /**
   * Pre-Tool Use Hook
   * - Re-read plan before critical decisions
   * - Check error history to avoid repeating mistakes
   */
  async preToolUse(context: HookContext): Promise<HookResult> {
    if (!this.hooksConfig.preToolUse) {
      return { shouldContinue: true };
    }

    const { toolName } = context;

    // Only trigger for critical tools
    if (!toolName || !CRITICAL_TOOLS.includes(toolName)) {
      return { shouldContinue: true };
    }

    const plan = await this.planManager.read();
    if (!plan) {
      return { shouldContinue: true };
    }

    let injectContext = '';

    // Check error history
    const recentErrors = await this.errorTracker.getRecentErrors(toolName, 3);
    if (recentErrors.length > 0) {
      injectContext += this.formatErrorHistory(toolName, recentErrors);
    }

    // Add current task reminder
    const currentTask = this.planManager.getCurrentTask();
    if (currentTask) {
      injectContext += this.formatCurrentTask(currentTask);
    }

    return {
      shouldContinue: true,
      injectContext: injectContext || undefined,
    };
  }

  /**
   * Post-Tool Use Hook
   * - 2-Action Rule: Remind to save findings after view operations
   * - Remind to update progress after write operations
   * - Log errors
   */
  async postToolUse(context: HookContext): Promise<HookResult> {
    if (!this.hooksConfig.postToolUse) {
      return { shouldContinue: true };
    }

    const { toolName, toolResult } = context;

    // Log errors
    if (toolResult && !toolResult.success && toolResult.error) {
      await this.errorTracker.log({
        toolName: toolName || 'unknown',
        message: toolResult.error,
        params: context.toolParams,
      });
    }

    // Update action count
    this.actionCount++;

    let injectContext = '';

    // 2-Action Rule: Check after view operations
    if (toolName && VIEW_TOOLS.includes(toolName)) {
      if (this.actionCount >= this.rulesConfig.actionThreshold) {
        this.actionCount = 0; // Reset counter
        injectContext += this.format2ActionReminder();
      }
    }

    // Remind to update progress after write operations
    if (
      toolName &&
      WRITE_TOOLS.includes(toolName) &&
      toolResult?.success
    ) {
      injectContext += this.formatWriteReminder();
    }

    return {
      shouldContinue: true,
      injectContext: injectContext || undefined,
    };
  }

  /**
   * Stop Hook
   * - Verify all plan phases are complete before allowing stop
   */
  async onStop(): Promise<HookResult> {
    if (!this.hooksConfig.onStop) {
      return { shouldContinue: true };
    }

    const plan = await this.planManager.read();

    if (!plan) {
      return { shouldContinue: true };
    }

    if (!this.planManager.isComplete()) {
      const incomplete = this.planManager.getIncompleteItems();

      return {
        shouldContinue: false,
        injectContext: this.formatCompletionCheck(incomplete),
        notification: 'Plan incomplete - verification required',
      };
    }

    return {
      shouldContinue: true,
      notification: `Plan completed: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps`,
    };
  }

  /**
   * Error Hook
   * - Log error
   * - Check 3-Strike Rule
   */
  async onError(context: HookContext): Promise<HookResult> {
    if (!this.hooksConfig.onError) {
      return { shouldContinue: true };
    }

    const { error, toolName } = context;

    // Log error
    await this.errorTracker.log({
      toolName: toolName || 'unknown',
      message: error?.message || 'Unknown error',
      stack: error?.stack,
      params: context.toolParams,
    });

    // Check 3-Strike Rule
    const errorCount = await this.errorTracker.getErrorCount(
      toolName || 'unknown',
      error?.message || ''
    );

    if (errorCount >= this.rulesConfig.errorStrikeLimit) {
      return {
        shouldContinue: true,
        injectContext: this.format3StrikeWarning(errorCount),
      };
    }

    return { shouldContinue: true };
  }

  // ==========================================================================
  // Reset Methods
  // ==========================================================================

  /**
   * Reset action counter
   */
  resetActionCount(): void {
    this.actionCount = 0;
  }

  /**
   * Get current action count
   */
  getActionCount(): number {
    return this.actionCount;
  }

  // ==========================================================================
  // Formatting Methods
  // ==========================================================================

  private formatPlanReminder(
    plan: TaskPlan,
    current: { phase: TaskPhase; step: TaskStep } | null
  ): string {
    let reminder = `<existing-plan>\n`;
    reminder += `Plan: ${plan.title}\n`;
    reminder += `Objective: ${plan.objective}\n`;
    reminder += `Progress: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps completed\n\n`;

    if (current) {
      reminder += `Current task:\n`;
      reminder += `- Phase: ${current.phase.title}\n`;
      reminder += `- Step: ${current.step.content}\n`;
    } else {
      const next = this.planManager.getNextPendingTask();
      if (next) {
        reminder += `Next task:\n`;
        reminder += `- Phase: ${next.phase.title}\n`;
        reminder += `- Step: ${next.step.content}\n`;
      }
    }

    reminder += `\nPlease continue from where you left off.\n`;
    reminder += `</existing-plan>`;

    return reminder;
  }

  private formatErrorHistory(
    toolName: string,
    errors: Array<{ message: string; count: number }>
  ): string {
    let history = `\n<error-history>\n`;
    history += `Previous failures with ${toolName}:\n`;

    for (const err of errors) {
      const strikeNote = err.count >= 3 ? ' [3-STRIKE]' : '';
      history += `- ${err.message} (${err.count} times)${strikeNote}\n`;
    }

    history += `Avoid repeating these mistakes.\n`;
    history += `</error-history>\n`;

    return history;
  }

  private formatCurrentTask(current: {
    phase: TaskPhase;
    step: TaskStep;
  }): string {
    let task = `\n<current-task>\n`;
    task += `Phase: ${current.phase.title}\n`;
    task += `Step: ${current.step.content}\n`;
    task += `</current-task>\n`;

    return task;
  }

  private format2ActionReminder(): string {
    return (
      `\n<reminder>\n` +
      `You've performed ${this.rulesConfig.actionThreshold} view operations. ` +
      `Consider saving important findings to findings.md before continuing.\n` +
      `Use the findings_write tool to persist discoveries.\n` +
      `</reminder>\n`
    );
  }

  private formatWriteReminder(): string {
    return (
      `\n<reminder>\n` +
      `File operation completed. Consider updating task_plan.md status if a step was completed.\n` +
      `Use plan_read to check current progress.\n` +
      `</reminder>\n`
    );
  }

  private formatCompletionCheck(incomplete: string): string {
    return (
      `<completion-check>\n` +
      `WARNING: Plan is not complete!\n\n` +
      `Incomplete items:\n${incomplete}\n\n` +
      `Please complete all tasks or explicitly mark them as skipped before stopping.\n` +
      `</completion-check>`
    );
  }

  private format3StrikeWarning(count: number): string {
    return (
      `<three-strike-warning>\n` +
      `This error has occurred ${count} times!\n` +
      `You must try a DIFFERENT approach. Do not repeat the same action.\n\n` +
      `Consider:\n` +
      `1. Checking error history in errors.md\n` +
      `2. Re-reading the task_plan.md for alternative approaches\n` +
      `3. Using ask_user_question to get guidance\n` +
      `4. Adding a finding to findings.md about this blocker\n` +
      `</three-strike-warning>`
    );
  }
}
