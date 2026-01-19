// ============================================================================
// Plan Read Tool - Read current task plan from task_plan.md
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { PlanningService } from '../../planning';

// Status icons
const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  blocked: '✖',
  skipped: '⊘',
} as const;

export const planReadTool: Tool = {
  name: 'plan_read',
  description:
    'Read the current task plan from task_plan.md. ' +
    'Use this to review your progress, objectives, and remaining tasks. ' +
    'Essential for staying on track during complex multi-step tasks.',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      includeCompleted: {
        type: 'boolean',
        description: 'Include completed steps in output (default: false)',
        default: false,
      },
      summary: {
        type: 'boolean',
        description: 'Return a brief summary instead of full plan (default: false)',
        default: false,
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const includeCompleted = (params.includeCompleted as boolean) || false;
    const summary = (params.summary as boolean) || false;

    const planningService = context.planningService as PlanningService | undefined;

    if (!planningService) {
      return {
        success: true,
        output:
          'No planning service available.\n' +
          'To create a plan, use todo_write with persist=true and planTitle.',
      };
    }

    try {
      const plan = await planningService.plan.read();

      if (!plan) {
        return {
          success: true,
          output:
            'No plan exists yet.\n' +
            'To create a plan, use todo_write with persist=true and provide a planTitle.',
        };
      }

      // Summary mode
      if (summary) {
        const current = planningService.plan.getCurrentTask();
        const next = planningService.plan.getNextPendingTask();

        let output = `**${plan.title}**\n`;
        output += `Progress: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps\n\n`;

        if (current) {
          output += `Current: ${current.step.content}\n`;
        } else if (next) {
          output += `Next: ${next.step.content}\n`;
        } else if (planningService.plan.isComplete()) {
          output += `Status: All tasks completed!\n`;
        }

        return { success: true, output };
      }

      // Full plan output
      let output = `# ${plan.title}\n\n`;
      output += `**Objective:** ${plan.objective}\n`;
      output += `**Progress:** ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps completed\n`;

      if (plan.metadata.blockedSteps > 0) {
        output += `**Skipped:** ${plan.metadata.blockedSteps} steps\n`;
      }

      output += `\n---\n\n`;

      for (const phase of plan.phases) {
        const phaseIcon = STATUS_ICONS[phase.status];
        output += `## ${phaseIcon} ${phase.title}\n\n`;

        if (phase.notes) {
          output += `> ${phase.notes}\n\n`;
        }

        for (const step of phase.steps) {
          // Skip completed steps if not requested
          if (!includeCompleted && step.status === 'completed') {
            continue;
          }

          const stepIcon = STATUS_ICONS[step.status];
          const marker = step.status === 'completed' ? '[x]' : '[ ]';
          output += `- ${marker} ${stepIcon} ${step.content}\n`;
        }

        output += '\n';
      }

      // Add current task highlight
      const current = planningService.plan.getCurrentTask();
      if (current) {
        output += `---\n\n`;
        output += `**Current Task:** ${current.step.content}\n`;
      }

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read plan: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      };
    }
  },
};
