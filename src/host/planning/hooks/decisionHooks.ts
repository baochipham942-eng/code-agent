// ============================================================================
// Decision Hooks - Active hooks that can block or inject context
// ============================================================================

import type { HookContext, TaskPlan, TaskPhase, TaskStep } from '../types';
import type { DecisionHook, HookDecision, HookPoint } from './types';
import type { PlanManager } from '../planManager';
import type { ErrorTracker } from '../errorTracker';
import { matchers, matchDangerousBash } from '../matchers';
import { getActionCount } from './observerHooks';

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

export interface DecisionHooksConfig {
  /** Threshold for action count before reminder (2-Action Rule) */
  actionThreshold: number;
  /** Error count threshold for 3-Strike Rule */
  errorStrikeLimit: number;
}

const DEFAULT_CONFIG: DecisionHooksConfig = {
  actionThreshold: 5,
  errorStrikeLimit: 3,
};

// ----------------------------------------------------------------------------
// Decision Hook Factory
// ----------------------------------------------------------------------------

/**
 * Creates decision hooks with dependencies injected
 */
export function createDecisionHooks(
  planManager: PlanManager,
  errorTracker: ErrorTracker,
  config: DecisionHooksConfig = DEFAULT_CONFIG
): Array<{ point: HookPoint; hook: DecisionHook }> {
  // -------------------------------------------------------------------------
  // 3-Strike Rule Hook
  // -------------------------------------------------------------------------
  const threeStrikeRule: DecisionHook = {
    id: 'three-strike-rule',
    name: 'Three Strike Rule',
    description:
      'Warns and injects context when same error occurs 3+ times',
    priority: 100, // High priority - check errors early
    matcher: (context: HookContext) => {
      return context.error !== undefined || context.toolResult?.success === false;
    },
    decide: async (context: HookContext): Promise<HookDecision> => {
      const toolName = context.toolName || 'unknown';
      const errorMessage =
        context.error?.message || context.toolResult?.error || 'Unknown error';

      const errorCount = await errorTracker.getErrorCount(toolName, errorMessage);

      if (errorCount >= config.errorStrikeLimit) {
        return {
          allow: true,
          injectContext: formatThreeStrikeWarning(errorCount),
          notification: `3-Strike Warning: Error occurred ${errorCount} times`,
          reason: 'Error threshold reached',
        };
      }

      return { allow: true };
    },
  };

  // -------------------------------------------------------------------------
  // Pre-Critical Tool Context Hook
  // -------------------------------------------------------------------------
  const preCriticalToolContext: DecisionHook = {
    id: 'pre-critical-tool-context',
    name: 'Pre-Critical Tool Context',
    description: 'Injects error history and current task before critical tools',
    priority: 50,
    matcher: matchers.category('critical'),
    decide: async (context: HookContext): Promise<HookDecision> => {
      const plan = await planManager.read();
      if (!plan) {
        return { allow: true };
      }

      let injectContext = '';

      // Check error history for this tool
      const recentErrors = await errorTracker.getRecentErrors(
        context.toolName,
        3
      );
      if (recentErrors.length > 0) {
        injectContext += formatErrorHistory(
          context.toolName || 'unknown',
          recentErrors
        );
      }

      // Add current task reminder
      const currentTask = planManager.getCurrentTask();
      if (currentTask) {
        injectContext += formatCurrentTask(currentTask);
      }

      return {
        allow: true,
        injectContext: injectContext || undefined,
      };
    },
  };

  // -------------------------------------------------------------------------
  // 2-Action Rule Hook (View Operations Reminder)
  // -------------------------------------------------------------------------
  const twoActionRule: DecisionHook = {
    id: 'two-action-rule',
    name: 'Two Action Rule',
    description:
      'Reminds to save findings after consecutive view operations',
    priority: 30,
    matcher: matchers.category('view'),
    decide: async (): Promise<HookDecision> => {
      const actionCount = getActionCount();

      if (actionCount >= config.actionThreshold) {
        return {
          allow: true,
          injectContext: formatTwoActionReminder(config.actionThreshold),
          reason: 'Action threshold reached',
        };
      }

      return { allow: true };
    },
  };

  // -------------------------------------------------------------------------
  // Write Operation Reminder Hook
  // -------------------------------------------------------------------------
  const writeOperationReminder: DecisionHook = {
    id: 'write-operation-reminder',
    name: 'Write Operation Reminder',
    description: 'Reminds to update plan progress after successful writes',
    priority: 20,
    matcher: (context: HookContext) => {
      return (
        matchers.category('write')(context) &&
        context.toolResult?.success === true
      );
    },
    decide: async (): Promise<HookDecision> => {
      return {
        allow: true,
        injectContext: formatWriteReminder(),
      };
    },
  };

  // -------------------------------------------------------------------------
  // Dangerous Bash Command Hook
  // -------------------------------------------------------------------------
  const dangerousBashBlock: DecisionHook = {
    id: 'dangerous-bash-block',
    name: 'Dangerous Bash Blocker',
    description: 'Blocks potentially dangerous bash commands',
    priority: 200, // Highest priority - safety first
    matcher: matchDangerousBash(),
    decide: async (context: HookContext): Promise<HookDecision> => {
      const command = context.toolParams?.command as string;
      return {
        allow: false,
        notification: 'Blocked potentially dangerous command',
        injectContext:
          `<safety-block>\n` +
          `The command "${command?.substring(0, 50)}..." was blocked for safety.\n` +
          `Please use a safer alternative or confirm with the user.\n` +
          `</safety-block>`,
        reason: 'Dangerous command detected',
      };
    },
  };

  // -------------------------------------------------------------------------
  // Plan Completion Check Hook
  // -------------------------------------------------------------------------
  const planCompletionCheck: DecisionHook = {
    id: 'plan-completion-check',
    name: 'Plan Completion Check',
    description: 'Verifies plan completion before allowing stop',
    priority: 40,
    matcher: matchers.any(), // Will only be registered for on_stop
    decide: async (): Promise<HookDecision> => {
      const plan = await planManager.read();

      // No plan exists - allow stop freely
      if (!plan) {
        return { allow: true };
      }

      // Small plans - allow stop (likely over-planned)
      if (plan.metadata.totalSteps <= 4) {
        return { allow: true };
      }

      // At least half done - allow with notification
      if (plan.metadata.completedSteps >= plan.metadata.totalSteps / 2) {
        const remaining = plan.metadata.totalSteps - plan.metadata.completedSteps;
        return {
          allow: true,
          notification: `Good progress! ${remaining} items remaining - reply to continue.`,
        };
      }

      // Check if complete
      if (planManager.isComplete()) {
        return {
          allow: true,
          notification: `Plan completed: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps`,
        };
      }

      // Not complete - check how much is left
      const incomplete = planManager.getIncompleteItems();
      const incompleteCount = (incomplete.match(/\n/g) || []).length;

      if (incompleteCount <= 3) {
        return {
          allow: true,
          notification: `Almost done! ${incompleteCount} items remaining.`,
        };
      }

      // Force continuation
      return {
        allow: false,
        injectContext: formatCompletionCheck(incomplete),
        notification: 'Plan incomplete - verification required',
        reason: 'Plan not complete',
      };
    },
  };

  // -------------------------------------------------------------------------
  // Existing Plan Reminder Hook
  // -------------------------------------------------------------------------
  const existingPlanReminder: DecisionHook = {
    id: 'existing-plan-reminder',
    name: 'Existing Plan Reminder',
    description: 'Reminds about existing incomplete plan at session start',
    priority: 60,
    matcher: matchers.any(), // Will only be registered for session_start
    decide: async (): Promise<HookDecision> => {
      const existingPlan = await planManager.read();

      if (existingPlan && !planManager.isComplete()) {
        const current = planManager.getCurrentTask();
        return {
          allow: true,
          injectContext: formatPlanReminder(existingPlan, current),
          notification: `Found existing plan: ${existingPlan.title} (${existingPlan.metadata.completedSteps}/${existingPlan.metadata.totalSteps} completed)`,
        };
      }

      return { allow: true };
    },
  };

  // -------------------------------------------------------------------------
  // Register hooks with their points
  // -------------------------------------------------------------------------
  return [
    { point: 'on_error', hook: threeStrikeRule },
    { point: 'post_tool_use', hook: threeStrikeRule }, // Also check after failed tools
    { point: 'pre_tool_use', hook: preCriticalToolContext },
    { point: 'post_tool_use', hook: twoActionRule },
    { point: 'post_tool_use', hook: writeOperationReminder },
    { point: 'pre_tool_use', hook: dangerousBashBlock },
    { point: 'on_stop', hook: planCompletionCheck },
    { point: 'session_start', hook: existingPlanReminder },
  ];
}

// ----------------------------------------------------------------------------
// Formatting Functions
// ----------------------------------------------------------------------------

function formatThreeStrikeWarning(count: number): string {
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

function formatErrorHistory(
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

function formatCurrentTask(current: {
  phase: TaskPhase;
  step: TaskStep;
}): string {
  let task = `\n<current-task>\n`;
  task += `Phase: ${current.phase.title}\n`;
  task += `Step: ${current.step.content}\n`;
  task += `</current-task>\n`;

  return task;
}

function formatTwoActionReminder(threshold: number): string {
  return (
    `\n<reminder>\n` +
    `You've performed ${threshold} view operations without writing. ` +
    `STOP READING AND START ACTING! If this is a creation task, use write_file NOW.\n` +
    `</reminder>\n`
  );
}

function formatWriteReminder(): string {
  return (
    `\n<reminder>\n` +
    `File operation completed. Consider updating task_plan.md status if a step was completed.\n` +
    `Use plan_read to check current progress.\n` +
    `</reminder>\n`
  );
}

function formatCompletionCheck(incomplete: string): string {
  return (
    `<completion-check>\n` +
    `WARNING: Plan is not complete!\n\n` +
    `Incomplete items:\n${incomplete}\n\n` +
    `Please complete all tasks or explicitly mark them as skipped before stopping.\n` +
    `</completion-check>`
  );
}

function formatPlanReminder(
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
  }

  reminder += `\nPlease continue from where you left off.\n`;
  reminder += `</existing-plan>`;

  return reminder;
}

// ----------------------------------------------------------------------------
// Hook Registry Helper
// ----------------------------------------------------------------------------

/**
 * Get all decision hooks for a specific hook point
 */
export function getDecisionHooksForPoint(
  hooks: Array<{ point: HookPoint; hook: DecisionHook }>,
  point: HookPoint
): DecisionHook[] {
  return hooks
    .filter((registration) => registration.point === point)
    .map((registration) => registration.hook)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher priority first
}
