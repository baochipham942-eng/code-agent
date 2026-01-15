// ============================================================================
// Plan Update Tool - Update task plan status
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { PlanningService, TaskStepStatus, TaskPhaseStatus } from '../../planning';

export const planUpdateTool: Tool = {
  name: 'plan_update',
  description:
    'Update the status of a step or phase in the task plan. ' +
    'Use this after completing a task step or when a step is blocked.',
  generations: ['gen3', 'gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      stepContent: {
        type: 'string',
        description: 'Content of the step to update (matches by content)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'skipped'],
        description: 'New status for the step',
      },
      phaseTitle: {
        type: 'string',
        description: 'Title of the phase (optional, helps narrow down if steps have similar names)',
      },
      addNote: {
        type: 'string',
        description: 'Add a note to the phase (optional)',
      },
    },
    required: ['stepContent', 'status'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const stepContent = params.stepContent as string;
    const status = params.status as TaskStepStatus;
    const phaseTitle = params.phaseTitle as string | undefined;
    const addNote = params.addNote as string | undefined;

    // Validate status
    const validStatuses: TaskStepStatus[] = ['pending', 'in_progress', 'completed', 'skipped'];
    if (!validStatuses.includes(status)) {
      return {
        success: false,
        error: `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`,
      };
    }

    const planningService = context.planningService as PlanningService | undefined;

    if (!planningService) {
      return {
        success: false,
        error: 'Planning service not available.',
      };
    }

    try {
      const plan = await planningService.plan.read();

      if (!plan) {
        return {
          success: false,
          error: 'No plan exists. Create one first using todo_write with persist=true.',
        };
      }

      // Find the step
      let foundPhase = null;
      let foundStep = null;

      for (const phase of plan.phases) {
        // If phaseTitle is specified, filter by it
        if (phaseTitle && !phase.title.toLowerCase().includes(phaseTitle.toLowerCase())) {
          continue;
        }

        const step = phase.steps.find((s) =>
          s.content.toLowerCase().includes(stepContent.toLowerCase())
        );

        if (step) {
          foundPhase = phase;
          foundStep = step;
          break;
        }
      }

      if (!foundPhase || !foundStep) {
        return {
          success: false,
          error: `Could not find step matching: "${stepContent}"`,
        };
      }

      // Update the step status
      await planningService.plan.updateStepStatus(foundPhase.id, foundStep.id, status);

      // Read updated plan
      const updatedPlan = await planningService.plan.read();

      // Format response
      const statusIcon = {
        pending: '○',
        in_progress: '◐',
        completed: '●',
        skipped: '⊘',
      }[status];

      let output = `Step updated: ${statusIcon} ${foundStep.content}\n`;
      output += `Phase: ${foundPhase.title}\n`;
      output += `New status: ${status}\n\n`;
      output += `Plan progress: ${updatedPlan?.metadata.completedSteps}/${updatedPlan?.metadata.totalSteps} completed`;

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        error: `Failed to update plan: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      };
    }
  },
};
