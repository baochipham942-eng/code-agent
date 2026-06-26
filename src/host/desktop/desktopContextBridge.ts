import type { PlanningService } from '../planning';
import { publishPlanningStateToRenderer } from '../planning';
import {
  buildRecoveredWorkOrchestrationHint,
  isContinuationLikeRequest,
  recoverRecentWorkIntoPlanning,
} from '../planning/recoveredWorkOrchestrator';
import { advanceTodoStatus, mergeTodos } from '../agent/todoParser';
import { createLogger } from '../services/infra/logger';
import type { SessionTask, TodoItem } from '../../shared/contract';
import {
  getDesktopActivityUnderstandingService,
  type DesktopTaskSyncResult,
} from './desktopActivityUnderstandingService';
import {
  syncDesktopTasksToPlanningService,
  type DesktopPlanningSyncResult,
} from './desktopActivityPlanningBridge';
import {
  buildWorkspaceActivityContextBlock,
  type WorkspaceActivitySearchOptions,
} from './workspaceActivitySearchService';

// Facade for desktop-activity Prompt Context Contributors (see ADR-017).
// Owns turn-lifecycle orchestration of desktop derived state: todo merging,
// task store sync, planning sync, workspace context block, recovered-work hint
// and continuation auto-recovery. Returns structured output; conversationRuntime
// owns Assembly Policy concerns (context pressure, token budgeting) and the
// final injection / event dispatch.

const logger = createLogger('DesktopContextBridge');

const DESKTOP_DATA_FRESHNESS_MS = 2 * 60 * 1000;

export async function fetchDesktopTodoCandidates(opts: {
  sinceHours: number;
  limit: number;
  maxAgeMs?: number;
}): Promise<TodoItem[]> {
  const desktopActivity = getDesktopActivityUnderstandingService();
  await desktopActivity.ensureFreshData(opts.maxAgeMs ?? DESKTOP_DATA_FRESHNESS_MS);
  return desktopActivity.listTodoItems({
    sinceHours: opts.sinceHours,
    limit: opts.limit,
  });
}

export function syncDesktopTodosToTaskStore(
  sessionId: string,
  opts: { sinceHours: number; limit: number },
): DesktopTaskSyncResult {
  return getDesktopActivityUnderstandingService().syncTodoCandidatesToTasks(sessionId, opts);
}

export async function syncDesktopTasksToPlanning(
  planningService: PlanningService,
  tasks: SessionTask[],
): Promise<DesktopPlanningSyncResult> {
  return syncDesktopTasksToPlanningService(planningService, tasks);
}

export async function buildDesktopWorkspaceContextBlock(
  userMessage: string,
  opts: WorkspaceActivitySearchOptions,
): Promise<string | null> {
  return buildWorkspaceActivityContextBlock(userMessage, opts);
}

export interface DesktopTurnBootstrapInput {
  sessionId: string;
  userMessage: string | undefined;
  planningService: PlanningService | undefined;
  existingTodos: TodoItem[];
  persistedTodos: TodoItem[];
  workspaceContextBudget: { maxTokens: number; maxItems: number };
}

export interface DesktopAutoRecoveryOutcome {
  planChanged: boolean;
  addedSteps: number;
  workspaceItems: number;
}

export interface DesktopTurnBootstrapOutput {
  advancedTodos: TodoItem[] | null;
  taskSync: DesktopTaskSyncResult;
  planningSyncChanged: boolean;
  workspaceContextBlock: string | null;
  recoveredWorkHint: string | null;
  autoRecovery: DesktopAutoRecoveryOutcome | null;
}

const EMPTY_TASK_SYNC: DesktopTaskSyncResult = {
  tasks: [],
  created: [],
  updated: [],
  skipped: [],
  supersededTodoKeys: [],
  totalCandidates: 0,
};

export async function bootstrapDesktopTurnContext(
  input: DesktopTurnBootstrapInput,
): Promise<DesktopTurnBootstrapOutput> {
  const {
    sessionId,
    userMessage,
    planningService,
    existingTodos,
    persistedTodos,
    workspaceContextBudget,
  } = input;

  let advancedTodos: TodoItem[] | null = null;
  let taskSync: DesktopTaskSyncResult = EMPTY_TASK_SYNC;
  let planningSyncChanged = false;
  let workspaceContextBlock: string | null = null;
  let recoveredWorkHint: string | null = null;
  let autoRecovery: DesktopAutoRecoveryOutcome | null = null;

  try {
    const desktopTodos = await fetchDesktopTodoCandidates({ sinceHours: 6, limit: 3 });

    let mergedTodos = desktopTodos;
    if (persistedTodos.length > 0) {
      mergedTodos = mergedTodos.length > 0
        ? mergeTodos(mergedTodos, persistedTodos)
        : persistedTodos;
    }
    if (existingTodos.length > 0) {
      mergedTodos = mergedTodos.length > 0
        ? mergeTodos(mergedTodos, existingTodos)
        : existingTodos;
    }

    if (mergedTodos.length > 0) {
      const advanced = advanceTodoStatus(mergedTodos).todos;
      if (JSON.stringify(existingTodos) !== JSON.stringify(advanced)) {
        advancedTodos = advanced;
      }
    }

    taskSync = syncDesktopTodosToTaskStore(sessionId, { sinceHours: 6, limit: 3 });

    if (planningService) {
      const planningSync = await syncDesktopTasksToPlanning(planningService, taskSync.tasks);
      if (
        planningSync.createdPlan
        || planningSync.createdPhase
        || planningSync.addedSteps.length > 0
        || planningSync.updatedSteps.length > 0
      ) {
        planningSyncChanged = true;
      }
    }

    if (userMessage) {
      workspaceContextBlock = await buildDesktopWorkspaceContextBlock(userMessage, {
        sinceHours: 24,
        limit: 5,
        refreshDesktop: false,
        minScore: 0.52,
        contextMaxTokens: workspaceContextBudget.maxTokens,
        contextMaxItems: workspaceContextBudget.maxItems,
      });

      recoveredWorkHint = await buildRecoveredWorkOrchestrationHint({
        userMessage,
        planningService,
        recoveredTaskCount: taskSync.totalCandidates,
        hasWorkspaceContext: Boolean(workspaceContextBlock),
      });
    }

    if (
      userMessage
      && planningService
      && taskSync.totalCandidates > 0
      && isContinuationLikeRequest(userMessage)
    ) {
      try {
        const recovery = await recoverRecentWorkIntoPlanning({
          planningService,
          sessionId,
          query: userMessage,
          sinceHours: 24,
          refreshDesktop: false,
        });
        autoRecovery = {
          planChanged: recovery.planChanged,
          addedSteps: recovery.planningSync.addedSteps.length,
          workspaceItems: recovery.workspaceResult?.items.length ?? 0,
        };
      } catch (autoRecoveryError) {
        logger.warn('Auto-recovery for continuation failed', { error: String(autoRecoveryError) });
      }
    }
  } catch (error) {
    logger.warn('Desktop-derived context bootstrap failed, continuing without it', {
      error: String(error),
    });
  }

  return {
    advancedTodos,
    taskSync,
    planningSyncChanged,
    workspaceContextBlock,
    recoveredWorkHint,
    autoRecovery,
  };
}

export async function publishPlanningStateAfterDesktopSync(
  planningService: PlanningService,
): Promise<void> {
  await publishPlanningStateToRenderer(planningService);
}

export type {
  DesktopTaskSyncResult,
  DesktopPlanningSyncResult,
};
