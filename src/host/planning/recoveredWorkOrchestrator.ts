import { randomUUID } from 'crypto';
import { createLogger } from '../services/infra/logger';
import type { PromptSuggestion } from '../services/core/promptSuggestions';
import {
  getDesktopActivityUnderstandingService,
  type DesktopTaskSyncResult,
} from '../desktop/desktopActivityUnderstandingService';
import {
  searchWorkspaceActivity,
  type WorkspaceActivitySearchItem,
  type WorkspaceActivitySearchResult,
} from '../desktop/workspaceActivitySearchService';
import {
  DESKTOP_RECOVERY_PLAN_TITLE,
  syncDesktopTasksToPlanningService,
  type DesktopPlanningSyncResult,
} from '../desktop/desktopActivityPlanningBridge';
import type { PlanningService } from './planningService';
import type { TaskPhase, TaskPhaseStatus, TaskPlan, TaskStep } from './types';

const logger = createLogger('RecoveredWorkOrchestrator');

export const WORKSPACE_RECOVERY_PHASE_TITLE = 'Recovered Workspace Activity';
export const WORKSPACE_RECOVERY_OBJECTIVE =
  'Continue recent work inferred from recovered desktop and workspace activity.';

const MAX_SUGGESTIONS = 3;
const MAX_NOTE_LENGTH = 720;
const CONTINUATION_PATTERNS = [
  /\bcontinue\b/i,
  /\bresume\b/i,
  /\bpick up\b/i,
  /\bcarry on\b/i,
  /\bfinish up\b/i,
  /\bwhat next\b/i,
  /继续/,
  /接着/,
  /承接/,
  /延续/,
  /上次/,
  /之前/,
  /收尾/,
  /继续做/,
  /继续推进/,
  /继续处理/,
  /接着做/,
];

export interface RecoverRecentWorkOptions {
  planningService: PlanningService;
  sessionId: string;
  query?: string;
  sinceHours?: number;
  desktopLimit?: number;
  workspaceLimit?: number;
  refreshDesktop?: boolean;
  refreshArtifacts?: boolean;
}

export interface RecoverRecentWorkResult {
  taskSync: DesktopTaskSyncResult;
  planningSync: DesktopPlanningSyncResult;
  workspaceResult: WorkspaceActivitySearchResult | null;
  createdWorkspacePhase: boolean;
  createdWorkspaceReviewStep: boolean;
  updatedWorkspaceNotes: boolean;
  planChanged: boolean;
  plan: TaskPlan | null;
}

export interface RecoveredWorkHintOptions {
  userMessage: string;
  planningService?: PlanningService;
  recoveredTaskCount?: number;
  hasWorkspaceContext?: boolean;
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isMeaningfulQuery(query: string | undefined): query is string {
  return typeof query === 'string' && query.trim().length >= 4;
}

function dedupeSuggestionText(value: string): string {
  return normalizeText(value).replace(/^继续[:：]?\s*/, '');
}

function buildSuggestionId(prefix: string, value: string): string {
  return `${prefix}:${dedupeSuggestionText(value).slice(0, 48)}`;
}

function pushSuggestion(
  suggestions: PromptSuggestion[],
  seen: Set<string>,
  text: string,
  source: PromptSuggestion['source'],
  extra?: Pick<PromptSuggestion, 'category' | 'timestampMs' | 'priority'>,
): void {
  const normalized = dedupeSuggestionText(text);
  if (!normalized || seen.has(normalized) || suggestions.length >= MAX_SUGGESTIONS) {
    return;
  }

  seen.add(normalized);
  suggestions.push({
    id: buildSuggestionId(source, normalized),
    text,
    source,
    ...extra,
  });
}

function findPhaseByTitle(plan: TaskPlan | null, title: string): TaskPhase | null {
  return plan?.phases.find((phase) => phase.title === title) || null;
}

function buildWorkspaceReviewStepContent(query: string): string {
  return `Review recovered workspace activity for "${truncate(query.trim(), 72)}"`;
}

function buildWorkspaceRecoveryStep(
  query: string,
  items: WorkspaceActivitySearchItem[],
): Omit<TaskStep, 'id'> {
  return {
    content: buildWorkspaceReviewStepContent(query),
    status: 'pending',
    activeForm: `Reviewing recovered workspace activity for "${truncate(query.trim(), 64)}"`,
    metadata: {
      source: 'workspace_activity',
      sourceKind: 'workspace_activity_search',
      recoveryQuery: query.trim(),
      workspaceSources: Array.from(new Set(items.map((item) => item.source))).sort(),
      workspaceItemIds: items.map((item) => item.id),
    },
  };
}

function buildWorkspaceRecoveryPlanStep(
  query: string,
  items: WorkspaceActivitySearchItem[],
): TaskStep {
  return {
    id: `workspace-recovery-step-${randomUUID()}`,
    ...buildWorkspaceRecoveryStep(query, items),
  };
}

function buildWorkspaceRecoveryNote(
  query: string,
  items: WorkspaceActivitySearchItem[],
): string {
  const parts = items.slice(0, 3).map((item) => {
    const title = truncate(item.title, 72);
    const snippet = truncate(item.snippet.replace(/\s+/g, ' '), 96);
    return `[${item.source}] ${title}${snippet ? ` - ${snippet}` : ''}`;
  });

  return truncate(
    `Recovered workspace signals for "${query.trim()}": ${parts.join('; ')}`,
    MAX_NOTE_LENGTH,
  );
}

function mergePhaseNotes(existing: string | undefined, next: string): string {
  const current = existing?.trim();
  if (!current) return next;
  if (normalizeText(current).includes(normalizeText(next))) {
    return current;
  }
  return truncate(`${current} | ${next}`, MAX_NOTE_LENGTH);
}

function computePhaseStatus(steps: TaskStep[]): TaskPhaseStatus {
  if (steps.length === 0) return 'pending';
  if (steps.every((s) => s.status === 'completed' || s.status === 'skipped')) return 'completed';
  if (steps.some((s) => s.status === 'in_progress')) return 'in_progress';
  return 'pending';
}

function countPlanMutations(result: DesktopPlanningSyncResult): boolean {
  return result.createdPlan
    || result.createdPhase
    || result.addedSteps.length > 0
    || result.updatedSteps.length > 0;
}

async function ensureWorkspaceRecoveryPhase(
  planningService: PlanningService,
  query: string,
  items: WorkspaceActivitySearchItem[],
): Promise<{
  createdWorkspacePhase: boolean;
  createdWorkspaceReviewStep: boolean;
  updatedWorkspaceNotes: boolean;
}> {
  const note = buildWorkspaceRecoveryNote(query, items);
  const stepContent = buildWorkspaceReviewStepContent(query);
  let plan = planningService.plan.getCurrentPlan() ?? await planningService.plan.read();
  let phase = findPhaseByTitle(plan, WORKSPACE_RECOVERY_PHASE_TITLE);
  let createdWorkspacePhase = false;
  let createdWorkspaceReviewStep = false;
  let updatedWorkspaceNotes = false;

  if (!plan) {
    await planningService.initialize();
    const createdPlan = await planningService.plan.create({
      title: DESKTOP_RECOVERY_PLAN_TITLE,
      objective: WORKSPACE_RECOVERY_OBJECTIVE,
      phases: [{
        id: `workspace-recovery-phase-${randomUUID()}`,
        title: WORKSPACE_RECOVERY_PHASE_TITLE,
        status: 'pending',
        notes: note,
        steps: [buildWorkspaceRecoveryPlanStep(query, items)],
      }],
    });
    plan = createdPlan;
    phase = findPhaseByTitle(plan, WORKSPACE_RECOVERY_PHASE_TITLE);
    createdWorkspacePhase = true;
    createdWorkspaceReviewStep = true;
    updatedWorkspaceNotes = true;
    return {
      createdWorkspacePhase,
      createdWorkspaceReviewStep,
      updatedWorkspaceNotes,
    };
  }

  if (!phase) {
    phase = await planningService.plan.addPhase({
      title: WORKSPACE_RECOVERY_PHASE_TITLE,
      notes: note,
      steps: [buildWorkspaceRecoveryPlanStep(query, items)],
    });
    createdWorkspacePhase = true;
    createdWorkspaceReviewStep = true;
    updatedWorkspaceNotes = true;
    return {
      createdWorkspacePhase,
      createdWorkspaceReviewStep,
      updatedWorkspaceNotes,
    };
  }

  const mergedNotes = mergePhaseNotes(phase.notes, note);
  if (mergedNotes !== (phase.notes || '')) {
    await planningService.plan.updatePhaseNotes(phase.id, mergedNotes);
    updatedWorkspaceNotes = true;
  }

  const hasReviewStep = phase.steps.some((step) => {
    const stepQuery = typeof step.metadata?.recoveryQuery === 'string'
      ? step.metadata.recoveryQuery
      : '';
    return normalizeText(step.content) === normalizeText(stepContent)
      || normalizeText(stepQuery) === normalizeText(query);
  });

  if (!hasReviewStep) {
    await planningService.plan.addStep(phase.id, buildWorkspaceRecoveryStep(query, items));
    createdWorkspaceReviewStep = true;
  }

  // Recompute phase status based on step states
  const refreshedPlan = await planningService.plan.read();
  const refreshedPhase = findPhaseByTitle(refreshedPlan, WORKSPACE_RECOVERY_PHASE_TITLE);
  if (refreshedPhase) {
    const desiredStatus = computePhaseStatus(refreshedPhase.steps);
    if (refreshedPhase.status !== desiredStatus) {
      await planningService.plan.updatePhaseStatus(refreshedPhase.id, desiredStatus);
    }
  }

  return {
    createdWorkspacePhase,
    createdWorkspaceReviewStep,
    updatedWorkspaceNotes,
  };
}

export function isContinuationLikeRequest(userMessage: string): boolean {
  const normalized = userMessage.trim();
  if (!normalized) return false;
  return CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export async function buildRecoveredWorkSuggestions(options: {
  sessionId: string;
  planningService?: PlanningService | null;
}): Promise<PromptSuggestion[]> {
  const suggestions: PromptSuggestion[] = [];
  const seen = new Set<string>();

  try {
    const planningService = options.planningService || undefined;
    if (planningService) {
      await planningService.plan.read();
      const current = planningService.plan.getCurrentTask();
      const next = planningService.plan.getNextPendingTask();

      if (current?.step.content) {
        pushSuggestion(suggestions, seen, current.step.content, 'history', {
          category: 'plan_step',
          priority: 'high',
        });
      } else if (next?.step.content) {
        pushSuggestion(suggestions, seen, next.step.content, 'history', {
          category: 'plan_step',
          priority: 'medium',
        });
      }
    }
  } catch (error) {
    logger.debug('Failed to build recovered-work suggestions from plan', {
      error: String(error),
    });
  }

  try {
    const todos = getDesktopActivityUnderstandingService().listTodoCandidates({
      limit: MAX_SUGGESTIONS,
      sinceHours: 12,
    });
    for (const todo of todos) {
      pushSuggestion(suggestions, seen, todo.content, 'history', {
        category: 'desktop_task',
        timestampMs: todo.createdAtMs,
        priority: 'medium',
      });
    }
  } catch (error) {
    logger.debug('Failed to build recovered-work suggestions from desktop activity', {
      error: String(error),
      sessionId: options.sessionId,
    });
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}

export async function buildRecoveredWorkOrchestrationHint(
  options: RecoveredWorkHintOptions,
): Promise<string | null> {
  if (!isContinuationLikeRequest(options.userMessage)) {
    return null;
  }

  const recoveredTaskCount = Math.max(0, options.recoveredTaskCount || 0);
  const hasWorkspaceContext = options.hasWorkspaceContext === true;

  let currentStep: string | null = null;
  let nextStep: string | null = null;

  try {
    if (options.planningService) {
      await options.planningService.plan.read();
      currentStep = options.planningService.plan.getCurrentTask()?.step.content || null;
      nextStep = options.planningService.plan.getNextPendingTask()?.step.content || null;
    }
  } catch (error) {
    logger.debug('Failed to inspect planning state for recovered-work hint', {
      error: String(error),
    });
  }

  if (!currentStep && !nextStep && recoveredTaskCount === 0 && !hasWorkspaceContext) {
    return null;
  }

  const lines = [
    'The user request looks like continuation or recovery work.',
  ];

  if (currentStep) {
    lines.push(`Current plan step: ${currentStep}`);
  } else if (nextStep) {
    lines.push(`Next pending plan step: ${nextStep}`);
  }

  if (recoveredTaskCount > 0) {
    lines.push(`Recovered desktop tasks available: ${recoveredTaskCount}`);
  }

  if (hasWorkspaceContext) {
    lines.push('Relevant merged workspace activity has already been recovered for this request.');
  }

  lines.push(
    'Before broad repo exploration:',
    '1. Reuse the existing plan/tasks if they match the request.',
    '2. If the target is still ambiguous, call Plan with action="recover_recent_work" and a focused query from the user request.',
    '3. When you adopt a recovered task, update its status instead of creating duplicate follow-up items.',
    'Recovered signals are hints; explicit user instructions still win.',
  );

  return lines.join('\n');
}

export async function recoverRecentWorkIntoPlanning(
  options: RecoverRecentWorkOptions,
): Promise<RecoverRecentWorkResult> {
  await options.planningService.initialize();

  const desktopActivity = getDesktopActivityUnderstandingService();
  const sinceHours = options.sinceHours || 24;
  const desktopLimit = options.desktopLimit || 3;
  const workspaceLimit = options.workspaceLimit || 4;

  if (options.refreshDesktop !== false) {
    await desktopActivity.ensureFreshData(2 * 60 * 1000).catch(async () => {
      await desktopActivity.refreshRecentActivity({
        lookbackHours: Math.max(sinceHours, 6),
      });
    });
  }

  const taskSync = desktopActivity.syncTodoCandidatesToTasks(options.sessionId, {
    limit: desktopLimit,
    sinceHours,
  });
  const planningSync = await syncDesktopTasksToPlanningService(
    options.planningService,
    taskSync.tasks,
  );

  let workspaceResult: WorkspaceActivitySearchResult | null = null;
  let createdWorkspacePhase = false;
  let createdWorkspaceReviewStep = false;
  let updatedWorkspaceNotes = false;
  let planChanged = countPlanMutations(planningSync);

  if (isMeaningfulQuery(options.query)) {
    workspaceResult = await searchWorkspaceActivity(options.query, {
      sinceHours,
      limit: workspaceLimit,
      refreshDesktop: false,
      refreshArtifacts: options.refreshArtifacts,
      minScore: 0.52,
    });

    if (workspaceResult.items.length > 0) {
      const workspaceSync = await ensureWorkspaceRecoveryPhase(
        options.planningService,
        options.query,
        workspaceResult.items,
      );
      createdWorkspacePhase = workspaceSync.createdWorkspacePhase;
      createdWorkspaceReviewStep = workspaceSync.createdWorkspaceReviewStep;
      updatedWorkspaceNotes = workspaceSync.updatedWorkspaceNotes;
      planChanged = planChanged
        || createdWorkspacePhase
        || createdWorkspaceReviewStep
        || updatedWorkspaceNotes;
    }
  }

  const plan = options.planningService.plan.getCurrentPlan() ?? await options.planningService.plan.read();

  return {
    taskSync,
    planningSync,
    workspaceResult,
    createdWorkspacePhase,
    createdWorkspaceReviewStep,
    updatedWorkspaceNotes,
    planChanged,
    plan,
  };
}
