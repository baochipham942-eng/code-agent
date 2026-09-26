// ============================================================================
// TaskManager (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s) },
  app: { getAppPath: () => '', getPath: () => '' },
}));

const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const getTaskMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);
const clearTasksMock = vi.fn();
const isDesktopDerivedSessionTaskMock = vi.fn().mockReturnValue(false);

vi.mock('../../../../../src/host/services/planning/taskStore', () => ({
  createTask: (...a: unknown[]) => createTaskMock(...a),
  updateTask: (...a: unknown[]) => updateTaskMock(...a),
  getTask: (...a: unknown[]) => getTaskMock(...a),
  listTasks: (...a: unknown[]) => listTasksMock(...a),
  clearTasks: (...a: unknown[]) => clearTasksMock(...a),
  isClosedTaskStatus: (status: string) => status === 'completed' || status === 'cancelled',
}));
vi.mock('../../../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    recordTodoFeedbackForTask: vi.fn(),
    clearTodoFeedbackForTask: vi.fn(),
  }),
  isDesktopDerivedSessionTask: (...a: unknown[]) => isDesktopDerivedSessionTaskMock(...a),
  getDesktopTaskKey: (task: { metadata?: { desktopTodoKey?: unknown } }) => (
    typeof task.metadata?.desktopTodoKey === 'string' ? task.metadata.desktopTodoKey : null
  ),
}));

import { taskManagerModule } from '../../../../../src/host/tools/modules/planning/taskManager';
import type { SessionTask } from '../../../../../src/shared/contract';
import { PlanManager } from '../../../../../src/host/planning/planManager';
import { createPlanningService } from '../../../../../src/host/planning';
import { syncDesktopTasksToPlanningService } from '../../../../../src/host/desktop/desktopActivityPlanningBridge';
import type { PlanningConfig, TaskPhase } from '../../../../../src/host/planning/types';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  listTasksMock.mockReturnValue([]);
});

function makeTask(id: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' = 'pending') {
  return {
    id,
    subject: `task ${id}`,
    description: `task ${id} description`,
    activeForm: `doing task ${id}`,
    status,
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('TaskManager schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(taskManagerModule.schema.name).toBe('TaskManager');
    expect(taskManagerModule.schema.category).toBe('planning');
    expect(taskManagerModule.schema.permissionLevel).toBe('write');
    expect(taskManagerModule.schema.inputSchema.required).toEqual(['action']);
    const props = taskManagerModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(['create', 'get', 'list', 'update', 'replace', 'patch']);
    expect(props.status.enum).toEqual(['pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'needs_decision', 'user_action', 'deleted']);
  });
});

describe('TaskManager dispatch', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      { action: 'list' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('未知 action → INVALID_ARGS', async () => {
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'bogus' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Unknown action');
    }
  });

  it('action=replace replaces the plan and promotes exactly one task to in_progress', async () => {
    let nextId = 0;
    createTaskMock.mockImplementation((_sessionId: string, input: Record<string, unknown>) => {
      nextId += 1;
      return { ...makeTask(String(nextId)), ...input, id: String(nextId), status: 'pending' };
    });
    listTasksMock.mockReturnValue([
      makeTask('1', 'in_progress'),
      makeTask('2', 'pending'),
    ]);

    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      {
        action: 'replace',
        tasks: [
          { subject: 'A' },
          { subject: 'B' },
        ],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(clearTasksMock).toHaveBeenCalledWith('sess-1');
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    expect(updateTaskMock).toHaveBeenCalledWith('sess-1', '1', { status: 'in_progress' });
  });

  it('action=patch keeps exactly one in_progress task when a batch moves focus', async () => {
    listTasksMock.mockReturnValue([
      makeTask('1', 'in_progress'),
      makeTask('2', 'pending'),
      makeTask('3', 'pending'),
    ]);

    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      {
        action: 'patch',
        tasks: [
          { taskId: '2', status: 'in_progress' },
          { taskId: '3', status: 'in_progress' },
        ],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledWith('sess-1', '1', { status: 'pending' });
    expect(updateTaskMock).toHaveBeenCalledWith('sess-1', '2', { status: 'in_progress' });
    expect(updateTaskMock).not.toHaveBeenCalledWith('sess-1', '3', { status: 'in_progress' });
  });

  it('action=list dispatch → 调用 list', async () => {
    listTasksMock.mockReturnValue([]);
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('No tasks');
  });

  it('action=create dispatch → 调用 create', async () => {
    createTaskMock.mockReturnValue({
      id: '1',
      subject: 's',
      status: 'pending',
      priority: 'normal',
      activeForm: 'S',
    });
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      { action: 'create', subject: 's', description: 'd' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('Task #1 created:');
  });

  it('action=get dispatch → 调用 get + NOT_FOUND', async () => {
    getTaskMock.mockReturnValue(undefined);
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'get', taskId: '99' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('action=update dispatch → 调用 update', async () => {
    getTaskMock.mockReturnValue({ id: '1', subject: 's', status: 'pending' });
    updateTaskMock.mockReturnValue({ id: '1', subject: 's', status: 'completed' });
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      { action: 'update', taskId: '1', status: 'completed', completionEvidence: 'checked the output file' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('Task #1 updated:');
  });
});

const planTempDirs: string[] = [];
const makePlanConfig = (workingDirectory: string): PlanningConfig => ({
  workingDirectory,
  sessionId: 'sess-plan',
});
const basePlan = (phases: TaskPhase[] = []) => ({
  title: 'My Plan',
  objective: 'ship it',
  phases,
});

function desktopTask(overrides: Partial<SessionTask> & Pick<SessionTask, 'id' | 'subject' | 'status'>): SessionTask {
  return {
    description: overrides.subject,
    activeForm: overrides.subject,
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {
      source: 'desktop_activity',
      sourceKind: 'activity_todo_candidate',
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(planTempDirs.splice(0, planTempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('desktop recovery wait-state mapping', () => {
  it('keeps getCurrentTask on the in_progress step when a needs_decision task shares the phase', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-plan-'));
    planTempDirs.push(dir);
    const planningService = createPlanningService(dir, `session-${crypto.randomUUID()}`);

    await syncDesktopTasksToPlanningService(planningService, [
      desktopTask({
        id: 'decide-hotel',
        subject: '选择酒店方案',
        status: 'needs_decision',
        blockedReason: '在两家酒店间选',
      }),
      desktopTask({
        id: 'draft-itinerary',
        subject: '起草行程',
        status: 'in_progress',
      }),
    ]);

    expect(planningService.plan.getCurrentTask()?.step.content).toBe('起草行程');
    expect(planningService.plan.getNextPendingTask()?.step.content).toBe('选择酒店方案（等你拍板）');

    const reloaded = await planningService.plan.read();
    expect(reloaded).not.toBeNull();
    expect(reloaded!.phases[0].status).toBe('in_progress');
    expect(reloaded!.phases[0].steps.map((step) => ({ content: step.content, status: step.status }))).toEqual([
      { content: '选择酒店方案（等你拍板）', status: 'pending' },
      { content: '起草行程', status: 'in_progress' },
    ]);
    expect(planningService.plan.getCurrentTask()?.step.content).toBe('起草行程');
  });

  it('does not duplicate an annotated wait step when the same tasks are synced again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-plan-'));
    planTempDirs.push(dir);
    const planningService = createPlanningService(dir, `session-${crypto.randomUUID()}`);
    const tasks = [
      desktopTask({ id: 'decide-hotel', subject: '选择酒店方案', status: 'needs_decision', blockedReason: '在两家酒店间选' }),
      desktopTask({ id: 'sign-contract', subject: '线下签合同', status: 'user_action', blockedReason: '需要本人签字' }),
    ];

    await syncDesktopTasksToPlanningService(planningService, tasks);
    await syncDesktopTasksToPlanningService(planningService, tasks);

    const reloaded = await planningService.plan.read();
    expect(reloaded!.phases.flatMap((phase) => phase.steps.map((step) => step.content))).toEqual([
      '选择酒店方案（等你拍板）',
      '线下签合同（等你操作）',
    ]);
  });

  it('round-trips blocked step status through ✖', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-plan-'));
    planTempDirs.push(dir);
    const writer = new PlanManager(makePlanConfig(dir));
    await writer.create(
      basePlan([
        {
          id: 'ph1',
          title: 'Blocked Phase',
          status: 'blocked',
          steps: [
            { id: 's1', content: 'waiting on login', status: 'blocked' },
            { id: 's2', content: 'active work', status: 'in_progress' },
          ],
        },
      ]),
    );

    const md = await fs.readFile(writer.getPlanPath(), 'utf-8');
    expect(md).toContain('✖ waiting on login');
    expect(md).toContain('◐ active work');

    const reader = new PlanManager(makePlanConfig(dir));
    const loaded = await reader.read();
    expect(loaded).not.toBeNull();
    expect(loaded!.phases[0].status).toBe('blocked');
    expect(loaded!.phases[0].steps.find((s) => s.content === 'waiting on login')!.status).toBe('blocked');
    expect(loaded!.phases[0].steps.find((s) => s.content === 'active work')!.status).toBe('in_progress');
  });
});
