import type { SessionTask } from '../../shared/types';
import type {
  PlanningService,
  TaskPhase,
  TaskPhaseStatus,
  TaskPlan,
  TaskStep,
  TaskStepStatus,
} from '../planning';
import { getDesktopTaskKey } from './desktopActivityUnderstandingService';

const DESKTOP_RECOVERY_PLAN_TITLE = 'Recovered Session Plan';
const DESKTOP_RECOVERY_OBJECTIVE = 'Continue recent work inferred from recent desktop activity.';
const DESKTOP_RECOVERY_PHASE_TITLE = 'Recovered From Desktop Activity';
const DESKTOP_RECOVERY_PHASE_NOTES =
  'Auto-generated from recent desktop activity. Treat as inferred work context until confirmed by the user.';

export interface DesktopPlanningSyncResult {
  totalDesktopTasks: number;
  createdPlan: boolean;
  createdPhase: boolean;
  addedSteps: string[];
  updatedSteps: string[];
  skippedSteps: string[];
  plan: TaskPlan | null;
}

function isDesktopDerivedTask(task: SessionTask): boolean {
  return task.metadata?.source === 'desktop_activity'
    && task.metadata?.sourceKind === 'activity_todo_candidate';
}

function normalizeStepContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toStepStatus(task: SessionTask): TaskStepStatus {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'in_progress') return 'in_progress';
  return 'pending';
}

function computePhaseStatus(steps: TaskStep[]): TaskPhaseStatus {
  if (steps.length === 0) return 'pending';
  if (steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
    return 'completed';
  }
  if (steps.some((step) => step.status === 'in_progress')) {
    return 'in_progress';
  }
  return 'pending';
}

function buildPhaseStep(task: SessionTask): TaskStep {
  return {
    id: `desktop-step-${task.id}`,
    content: task.subject,
    status: toStepStatus(task),
    activeForm: task.activeForm,
    metadata: {
      source: 'desktop_activity',
      sourceKind: 'activity_todo_candidate',
      desktopTodoKey: getDesktopTaskKey(task) || task.id,
      sourceTaskId: task.id,
    },
  };
}

function buildRecoveryPhase(tasks: SessionTask[]): TaskPhase {
  const steps = tasks.map(buildPhaseStep);
  return {
    id: `desktop-phase-${Date.now()}`,
    title: DESKTOP_RECOVERY_PHASE_TITLE,
    status: computePhaseStatus(steps),
    notes: DESKTOP_RECOVERY_PHASE_NOTES,
    steps,
  };
}

function getAllPlanSteps(plan: TaskPlan): Array<{ phase: TaskPhase; step: TaskStep }> {
  return plan.phases.flatMap((phase) => phase.steps.map((step) => ({ phase, step })));
}

export async function syncDesktopTasksToPlanningService(
  planningService: PlanningService,
  tasks: SessionTask[]
): Promise<DesktopPlanningSyncResult> {
  const desktopTasks = tasks
    .filter(isDesktopDerivedTask)
    .filter((task) => task.status !== 'completed');

  if (desktopTasks.length === 0) {
    return {
      totalDesktopTasks: 0,
      createdPlan: false,
      createdPhase: false,
      addedSteps: [],
      updatedSteps: [],
      skippedSteps: [],
      plan: planningService.plan.getCurrentPlan() ?? await planningService.plan.read(),
    };
  }

  await planningService.initialize();

  let createdPlan = false;
  let createdPhase = false;
  const addedSteps: string[] = [];
  const updatedSteps: string[] = [];
  const skippedSteps: string[] = [];

  let plan = planningService.plan.getCurrentPlan() ?? await planningService.plan.read();
  if (!plan) {
    createdPlan = true;
    createdPhase = true;
    const recoveryPhase = buildRecoveryPhase(desktopTasks);
    plan = await planningService.plan.create({
      title: DESKTOP_RECOVERY_PLAN_TITLE,
      objective: DESKTOP_RECOVERY_OBJECTIVE,
      phases: [recoveryPhase],
    });
    return {
      totalDesktopTasks: desktopTasks.length,
      createdPlan,
      createdPhase,
      addedSteps: desktopTasks.map((task) => task.subject),
      updatedSteps: [],
      skippedSteps: [],
      plan,
    };
  }

  const stepByContent = new Map(
    getAllPlanSteps(plan).map((item) => [normalizeStepContent(item.step.content), item] as const)
  );
  let recoveryPhase = plan.phases.find((phase) => phase.title === DESKTOP_RECOVERY_PHASE_TITLE) || null;
  const missingTasks: SessionTask[] = [];

  for (const task of desktopTasks) {
    const key = normalizeStepContent(task.subject);
    const existing = stepByContent.get(key);
    const desiredStatus = toStepStatus(task);

    if (!existing) {
      missingTasks.push(task);
      continue;
    }

    if (existing.phase.title === DESKTOP_RECOVERY_PHASE_TITLE && existing.step.status !== desiredStatus) {
      await planningService.plan.updateStepStatus(existing.phase.id, existing.step.id, desiredStatus);
      updatedSteps.push(task.subject);
      continue;
    }

    skippedSteps.push(task.subject);
  }

  if (missingTasks.length > 0) {
    if (!recoveryPhase) {
      recoveryPhase = await planningService.plan.addPhase({
        title: DESKTOP_RECOVERY_PHASE_TITLE,
        notes: DESKTOP_RECOVERY_PHASE_NOTES,
        steps: missingTasks.map(buildPhaseStep),
      });
      createdPhase = true;
      addedSteps.push(...missingTasks.map((task) => task.subject));
    } else {
      for (const task of missingTasks) {
        await planningService.plan.addStep(recoveryPhase.id, {
          content: task.subject,
          status: toStepStatus(task),
          activeForm: task.activeForm,
          metadata: {
            source: 'desktop_activity',
            sourceKind: 'activity_todo_candidate',
            desktopTodoKey: getDesktopTaskKey(task) || task.id,
            sourceTaskId: task.id,
          },
        });
        addedSteps.push(task.subject);
      }
    }
  }

  plan = await planningService.plan.read();
  recoveryPhase = plan?.phases.find((phase) => phase.title === DESKTOP_RECOVERY_PHASE_TITLE) || null;

  if (recoveryPhase) {
    const desiredPhaseStatus = computePhaseStatus(recoveryPhase.steps);
    if (recoveryPhase.status !== desiredPhaseStatus) {
      await planningService.plan.updatePhaseStatus(recoveryPhase.id, desiredPhaseStatus);
      plan = await planningService.plan.read();
    }
  }

  return {
    totalDesktopTasks: desktopTasks.length,
    createdPlan,
    createdPhase,
    addedSteps,
    updatedSteps,
    skippedSteps,
    plan,
  };
}
