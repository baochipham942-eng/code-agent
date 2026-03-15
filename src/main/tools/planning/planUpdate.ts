// ============================================================================
// Plan Update Tool - Update task plan status
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getDesktopActivityUnderstandingService, isDesktopDerivedSessionTask } from '../../memory/desktopActivityUnderstandingService';
import { recordWorkspaceActivityFeedback, clearWorkspaceActivityFeedback } from '../../memory/workspaceActivitySearchService';
import type { PlanningService, TaskStep, TaskStepStatus, TaskPhaseStatus } from '../../planning';
import { WORKSPACE_RECOVERY_PHASE_TITLE } from '../../planning/recoveredWorkOrchestrator';
import { listTasks } from './taskStore';

function computeWorkspacePhaseStatus(steps: TaskStep[]): TaskPhaseStatus {
  if (steps.length === 0) return 'pending';
  if (steps.every((s) => s.status === 'completed' || s.status === 'skipped')) return 'completed';
  if (steps.some((s) => s.status === 'in_progress')) return 'in_progress';
  return 'pending';
}

function normalizeStepContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getDesktopTodoKeyFromStep(step: { metadata?: Record<string, unknown> }): string | null {
  return typeof step.metadata?.desktopTodoKey === 'string'
    ? step.metadata.desktopTodoKey
    : null;
}

function mergePhaseNotes(existing: string | undefined, next: string | undefined): string | undefined {
  if (!next) return existing;
  const normalizedNext = next.trim();
  if (!normalizedNext) return existing;
  const current = existing?.trim();
  if (!current) return normalizedNext;
  if (current.includes(normalizedNext)) return current;
  return `${current} | ${normalizedNext}`;
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

      const mergedNotes = mergePhaseNotes(foundPhase.notes, addNote);
      if (mergedNotes !== foundPhase.notes) {
        await planningService.plan.updatePhaseNotes(foundPhase.id, mergedNotes);
      }

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

      // Workspace activity feedback: write back status for workspace-derived steps
      try {
        if (foundStep.metadata?.sourceKind === 'workspace_activity_search') {
          const itemIds = Array.isArray(foundStep.metadata.workspaceItemIds)
            ? (foundStep.metadata.workspaceItemIds as string[])
            : [];
          if (status === 'completed' || status === 'skipped') {
            for (const id of itemIds) {
              recordWorkspaceActivityFeedback(id, status === 'completed' ? 'completed' : 'dismissed', { sessionId, source: 'plan' });
            }
          } else if (status === 'in_progress') {
            for (const id of itemIds) {
              recordWorkspaceActivityFeedback(id, 'accepted', { sessionId, source: 'plan' });
            }
          } else if (status === 'pending') {
            for (const id of itemIds) {
              clearWorkspaceActivityFeedback(id);
            }
          }
        }
      } catch {
        // Workspace activity feedback is best-effort.
      }

      // Auto-recompute phase status for workspace recovery phase
      if (foundPhase.title === WORKSPACE_RECOVERY_PHASE_TITLE) {
        try {
          const refreshedPlan = await planningService.plan.read();
          const refreshedPhase = refreshedPlan?.phases.find((p) => p.id === foundPhase.id);
          if (refreshedPhase) {
            const desired = computeWorkspacePhaseStatus(refreshedPhase.steps);
            if (refreshedPhase.status !== desired) {
              await planningService.plan.updatePhaseStatus(refreshedPhase.id, desired);
            }
          }
        } catch {
          // Phase status recomputation is best-effort.
        }
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
      if (mergedNotes && addNote) {
        output += `Phase note updated.\n\n`;
      }
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
