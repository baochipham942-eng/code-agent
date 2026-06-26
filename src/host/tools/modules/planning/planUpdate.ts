// ============================================================================
// PlanUpdate (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/main/tools/planning/planUpdate.ts (legacy Tool planUpdateTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED /
//   NOT_FOUND / DOMAIN_ERROR
// - 行为保真：
//   * step 模糊匹配 / phaseTitle 过滤
//   * mergePhaseNotes (existing | next)
//   * desktop activity feedback (sourceKind/desktopTodoKey)
//   * workspace activity feedback (workspaceItemIds)
//   * Workspace recovery phase auto-recompute
//   * 输出 "Step updated: <icon> <content>" + Phase + status + Plan progress
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import {
  getDesktopActivityUnderstandingService,
  isDesktopDerivedSessionTask,
} from '../../../desktop/desktopActivityUnderstandingService';
import {
  recordWorkspaceActivityFeedback,
  clearWorkspaceActivityFeedback,
} from '../../../desktop/workspaceActivitySearchService';
import type {
  PlanningService,
  TaskStep,
  TaskStepStatus,
  TaskPhaseStatus,
} from '../../../planning';
import { WORKSPACE_RECOVERY_PHASE_TITLE } from '../../../planning/recoveredWorkOrchestrator';
import { listTasks } from '../../../services/planning/taskStore';
import { planUpdateSchema as schema } from './planUpdate.schema';

const VALID_STATUSES: readonly TaskStepStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'skipped',
];

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
  return typeof step.metadata?.desktopTodoKey === 'string' ? step.metadata.desktopTodoKey : null;
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

export async function executePlanUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const stepContent = args.stepContent as string | undefined;
  const status = args.status as TaskStepStatus | undefined;
  const phaseTitle = args.phaseTitle as string | undefined;
  const addNote = args.addNote as string | undefined;

  if (!stepContent || typeof stepContent !== 'string') {
    return { ok: false, error: 'stepContent is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    return {
      ok: false,
      error: `Invalid status: ${String(status)}. Must be one of: ${VALID_STATUSES.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const planningService = ctx.planningService as PlanningService | undefined;
  if (!planningService) {
    return { ok: false, error: 'Planning service not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const plan = await planningService.plan.read();
    if (!plan) {
      return {
        ok: false,
        error: 'No plan exists. Create one first using plan_update.',
        code: 'NOT_FOUND',
      };
    }

    let foundPhase = null;
    let foundStep = null;

    for (const phase of plan.phases) {
      if (phaseTitle && !phase.title.toLowerCase().includes(phaseTitle.toLowerCase())) {
        continue;
      }
      const step = phase.steps.find((s) =>
        s.content.toLowerCase().includes(stepContent.toLowerCase()),
      );
      if (step) {
        foundPhase = phase;
        foundStep = step;
        break;
      }
    }

    if (!foundPhase || !foundStep) {
      return {
        ok: false,
        error: `Could not find step matching: "${stepContent}"`,
        code: 'NOT_FOUND',
      };
    }

    await planningService.plan.updateStepStatus(foundPhase.id, foundStep.id, status);

    const mergedNotes = mergePhaseNotes(foundPhase.notes, addNote);
    if (mergedNotes !== foundPhase.notes) {
      await planningService.plan.updatePhaseNotes(foundPhase.id, mergedNotes);
    }

    const sessionId = ctx.sessionId || 'default';
    const stepTodoKey = getDesktopTodoKeyFromStep(foundStep);
    const matchingDesktopTask = listTasks(sessionId).find(
      (task) =>
        isDesktopDerivedSessionTask(task) &&
        (task.metadata?.desktopTodoKey === stepTodoKey ||
          normalizeStepContent(task.subject) === normalizeStepContent(foundStep.content)),
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
          desktopActivity.recordTodoFeedbackForTask(matchingDesktopTask, 'accepted', {
            sessionId,
            source: 'plan',
          });
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

    try {
      if (foundStep.metadata?.sourceKind === 'workspace_activity_search') {
        const itemIds = Array.isArray(foundStep.metadata.workspaceItemIds)
          ? (foundStep.metadata.workspaceItemIds as string[])
          : [];
        if (status === 'completed' || status === 'skipped') {
          for (const id of itemIds) {
            recordWorkspaceActivityFeedback(
              id,
              status === 'completed' ? 'completed' : 'dismissed',
              { sessionId, source: 'plan' },
            );
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

    const updatedPlan = await planningService.plan.read();

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

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('plan_update done', { status });
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to update plan: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class PlanUpdateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePlanUpdate(args, ctx, canUseTool, onProgress);
  }
}

export const planUpdateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PlanUpdateHandler();
  },
};
