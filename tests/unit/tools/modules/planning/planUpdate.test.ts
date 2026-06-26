// ============================================================================
// PlanUpdate (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const desktopActivityServiceMock = {
  recordTodoFeedbackForTask: vi.fn(),
  recordTodoFeedback: vi.fn(),
  clearTodoFeedbackForTask: vi.fn(),
  clearTodoFeedback: vi.fn(),
};
const isDesktopDerivedSessionTaskMock = vi.fn().mockReturnValue(false);
const recordWorkspaceActivityFeedbackMock = vi.fn();
const clearWorkspaceActivityFeedbackMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);

vi.mock('../../../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => desktopActivityServiceMock,
  isDesktopDerivedSessionTask: (...args: unknown[]) => isDesktopDerivedSessionTaskMock(...args),
}));
vi.mock('../../../../../src/host/desktop/workspaceActivitySearchService', () => ({
  recordWorkspaceActivityFeedback: (...args: unknown[]) => recordWorkspaceActivityFeedbackMock(...args),
  clearWorkspaceActivityFeedback: (...args: unknown[]) => clearWorkspaceActivityFeedbackMock(...args),
}));
vi.mock('../../../../../src/host/services/planning/taskStore', () => ({
  listTasks: (...args: unknown[]) => listTasksMock(...args),
}));
vi.mock('../../../../../src/host/planning/recoveredWorkOrchestrator', () => ({
  WORKSPACE_RECOVERY_PHASE_TITLE: 'Recovered Workspace Activity',
}));

import { planUpdateModule } from '../../../../../src/host/tools/modules/planning/planUpdate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

interface MockPlanService {
  plan: {
    read: ReturnType<typeof vi.fn>;
    updateStepStatus: ReturnType<typeof vi.fn>;
    updatePhaseNotes: ReturnType<typeof vi.fn>;
    updatePhaseStatus: ReturnType<typeof vi.fn>;
  };
}

function makeMockService(planSequence: unknown[]): MockPlanService {
  const planRead = vi.fn();
  for (const v of planSequence) planRead.mockResolvedValueOnce(v);
  // fallback for additional reads
  planRead.mockResolvedValue(planSequence[planSequence.length - 1]);
  return {
    plan: {
      read: planRead,
      updateStepStatus: vi.fn().mockResolvedValue(undefined),
      updatePhaseNotes: vi.fn().mockResolvedValue(undefined),
      updatePhaseStatus: vi.fn().mockResolvedValue(undefined),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopDerivedSessionTaskMock.mockReturnValue(false);
  listTasksMock.mockReturnValue([]);
});

describe('plan_update schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(planUpdateModule.schema.name).toBe('plan_update');
    expect(planUpdateModule.schema.category).toBe('planning');
    expect(planUpdateModule.schema.permissionLevel).toBe('write');
    expect(planUpdateModule.schema.allowInPlanMode).toBe(true);
    expect(planUpdateModule.schema.inputSchema.required).toEqual(['stepContent', 'status']);
    const props = planUpdateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.status.enum).toEqual(['pending', 'in_progress', 'completed', 'skipped']);
  });
});

describe('plan_update behavior', () => {
  it('缺 stepContent → INVALID_ARGS', async () => {
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute({ status: 'completed' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('Invalid status → INVALID_ARGS', async () => {
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'x', status: 'bogus' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Invalid status');
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'x', status: 'completed' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'x', status: 'completed' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('缺 planningService → NOT_INITIALIZED', async () => {
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'x', status: 'completed' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
  });

  it('plan 不存在 → NOT_FOUND', async () => {
    const service = makeMockService([null]);
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'x', status: 'completed' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('No plan exists');
    }
  });

  it('step 找不到 → NOT_FOUND', async () => {
    const service = makeMockService([
      {
        title: 'P',
        phases: [{ id: 'ph', title: 'A', status: 'pending', steps: [{ id: 's1', content: 'foo', status: 'pending' }] }],
        metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
      },
    ]);
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'no-match', status: 'completed' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('Could not find step');
    }
  });

  it('happy path 模糊匹配 + 输出 1:1 复刻 (icon/Phase/Plan progress)', async () => {
    const planAfter = {
      title: 'P',
      phases: [
        {
          id: 'ph',
          title: 'A',
          status: 'in_progress',
          steps: [{ id: 's1', content: 'Implement login', status: 'completed' }],
        },
      ],
      metadata: { totalSteps: 1, completedSteps: 1, blockedSteps: 0 },
    };
    const planBefore = {
      ...planAfter,
      phases: [{ ...planAfter.phases[0], steps: [{ id: 's1', content: 'Implement login', status: 'pending' }] }],
      metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
    };
    const service = makeMockService([planBefore, planAfter]);
    const handler = await planUpdateModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { stepContent: 'login', status: 'completed' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Step updated: ● Implement login');
      expect(result.output).toContain('Phase: A');
      expect(result.output).toContain('New status: completed');
      expect(result.output).toContain('Plan progress: 1/1 completed');
    }
    expect(service.plan.updateStepStatus).toHaveBeenCalledWith('ph', 's1', 'completed');
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'plan_update' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('addNote 触发 mergePhaseNotes → updatePhaseNotes 调用 + 提示行', async () => {
    const planBefore = {
      title: 'P',
      phases: [
        {
          id: 'ph',
          title: 'A',
          status: 'pending',
          notes: 'original',
          steps: [{ id: 's1', content: 'do x', status: 'pending' }],
        },
      ],
      metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
    };
    const planAfter = {
      ...planBefore,
      metadata: { totalSteps: 1, completedSteps: 1, blockedSteps: 0 },
    };
    const service = makeMockService([planBefore, planAfter]);
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'do x', status: 'completed', addNote: 'extra info' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(service.plan.updatePhaseNotes).toHaveBeenCalledWith('ph', 'original | extra info');
    if (result.ok) expect(result.output).toContain('Phase note updated.');
  });

  it('updateStepStatus throws → DOMAIN_ERROR', async () => {
    const service = makeMockService([
      {
        title: 'P',
        phases: [{ id: 'ph', title: 'A', status: 'pending', steps: [{ id: 's1', content: 'foo', status: 'pending' }] }],
        metadata: { totalSteps: 1, completedSteps: 0, blockedSteps: 0 },
      },
    ]);
    service.plan.updateStepStatus.mockRejectedValueOnce(new Error('db error'));
    const handler = await planUpdateModule.createHandler();
    const result = await handler.execute(
      { stepContent: 'foo', status: 'completed' },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('db error');
    }
  });
});
