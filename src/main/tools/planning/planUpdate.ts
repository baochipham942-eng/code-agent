// ============================================================================
// Plan Update Tool - Update task plan status
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getDesktopActivityUnderstandingService, isDesktopDerivedSessionTask } from '../../memory/desktopActivityUnderstandingService';
import type { PlanningService, TaskStepStatus, TaskPhaseStatus } from '../../planning';
import { listTasks } from './taskStore';

function normalizeStepContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getDesktopTodoKeyFromStep(step: { metadata?: Record<string, unknown> }): string | null {
  return typeof step.metadata?.desktopTodoKey === 'string'
    ? step.metadata.desktopTodoKey
    : null;
}

export const planUpdateTool: Tool = {
  name: 'plan_update',
  description:
    'Update the status of a step or phase in the task plan. ' +
    'Use this after completing a task step or when a step is blocked.',
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
          error: 'No plan exists. Create one first using plan_update.',
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

      const sessionId = (context as unknown as { sessionId?: string }).sessionId || 'default';
      const stepTodoKey = getDesktopTodoKeyFromStep(foundStep);
      const matchingDesktopTask = listTasks(sessionId).find((task) =>
        isDesktopDerivedSessionTask(task)
        && (
          task.metadata?.desktopTodoKey === stepTodoKey
          || normalizeStepContent(task.subject) === normalizeStepContent(foundStep.content)
        )
      );

      try {
        const desktopActivity = getDesktopActivityUnderstandingService();
        if (matchingDesktopTask) {
          if (status === 'completed' || status === 'skipped') {
            desktopActivity.recordTodoFeedbackForTask(
              matchingDesktopTask,
              status === 'completed' ? 'completed' : 'dismissed',
              { sessionId, source: 'plan' },
            );
          } else if (status === 'in_progress') {
            desktopActivity.recordTodoFeedbackForTask(
              matchingDesktopTask,
              'accepted',
              { sessionId, source: 'plan' },
            );
          } else if (status === 'pending') {
            desktopActivity.clearTodoFeedbackForTask(matchingDesktopTask);
          }
        } else if (stepTodoKey) {
          if (status === 'completed' || status === 'skipped') {
            desktopActivity.recordTodoFeedback({
              todoKey: stepTodoKey,
              status: status === 'completed' ? 'completed' : 'dismissed',
              sessionId,
              source: 'plan',
              reason: 'plan_step_metadata',
            });
          } else if (status === 'in_progress') {
            desktopActivity.recordTodoFeedback({
              todoKey: stepTodoKey,
              status: 'accepted',
              sessionId,
              source: 'plan',
              reason: 'plan_step_metadata',
            });
          } else if (status === 'pending') {
            desktopActivity.clearTodoFeedback(stepTodoKey);
          }
        }
      } catch {
        // Feedback sync is best-effort and should not block plan updates.
      }

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
