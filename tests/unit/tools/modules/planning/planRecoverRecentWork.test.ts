// ============================================================================
// PlanRecoverRecentWork (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const recoverRecentWorkIntoPlanningMock = vi.fn();
const publishPlanningStateToRendererMock = vi.fn();

vi.mock('../../../../../src/main/planning/recoveredWorkOrchestrator', () => ({
  recoverRecentWorkIntoPlanning: (...args: unknown[]) => recoverRecentWorkIntoPlanningMock(...args),
}));
vi.mock('../../../../../src/main/planning', () => ({
  publishPlanningStateToRenderer: (...args: unknown[]) => publishPlanningStateToRendererMock(...args),
}));

import { planRecoverRecentWorkModule } from '../../../../../src/main/tools/modules/planning/planRecoverRecentWork';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('plan_recover_recent_work schema', () => {
  it('对齐 legacy schema name/category/readOnly', () => {
    expect(planRecoverRecentWorkModule.schema.name).toBe('plan_recover_recent_work');
    expect(planRecoverRecentWorkModule.schema.category).toBe('planning');
    expect(planRecoverRecentWorkModule.schema.permissionLevel).toBe('read');
    expect(planRecoverRecentWorkModule.schema.readOnly).toBe(true);
    expect(planRecoverRecentWorkModule.schema.allowInPlanMode).toBe(true);
  });
});

describe('plan_recover_recent_work behavior', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await planRecoverRecentWorkModule.createHandler();
    const result = await handler.execute({}, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERMISSION_DENIED');
    }
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await planRecoverRecentWorkModule.createHandler();
    const result = await handler.execute({}, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('缺 planningService → NOT_INITIALIZED', async () => {
    const handler = await planRecoverRecentWorkModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('Planning service not available');
    }
  });

  it('happy path → 输出 1:1 复刻 legacy + 透传 emit task_update', async () => {
    recoverRecentWorkIntoPlanningMock.mockResolvedValue({
      taskSync: {
        created: [{ id: 't1' }],
        updated: [{ id: 't2' }],
        totalCandidates: 5,
        tasks: [{ id: 't1' }, { id: 't2' }],
      },
      planningSync: { addedSteps: [{ id: 's1' }], updatedSteps: [] },
      planChanged: true,
      workspaceResult: { items: [{}, {}], warnings: [] },
      createdWorkspacePhase: true,
      createdWorkspaceReviewStep: false,
      updatedWorkspaceNotes: false,
    });

    const emitFn = vi.fn();
    const handler = await planRecoverRecentWorkModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { query: 'foo', sinceHours: 12 },
      makeCtx({
        planningService: { name: 'svc' },
        emit: emitFn,
      } as unknown as Partial<ToolContext>),
      allowAll,
      onProgress,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Recovered recent work signals into planning.');
      expect(result.output).toContain('Desktop-derived tasks: 5 candidates, 1 created, 1 updated.');
      expect(result.output).toContain('Planning bridge: 1 steps added, 0 steps updated.');
      expect(result.output).toContain('Workspace matches: 2 relevant merged items.');
      expect(result.output).toContain('Added a dedicated "Recovered Workspace Activity" phase.');
      expect(result.meta?.taskCandidates).toBe(5);
      expect(result.meta?.createdTasks).toBe(1);
      expect(result.meta?.planChanged).toBe(true);
    }

    expect(emitFn).toHaveBeenCalledWith('task_update', expect.objectContaining({
      action: 'sync',
      source: 'recovered_work',
      taskIds: ['t1', 't2'],
    }));
    expect(publishPlanningStateToRendererMock).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'plan_recover_recent_work' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('无变更 + 无 workspace → "No additional planning mutations were needed."', async () => {
    recoverRecentWorkIntoPlanningMock.mockResolvedValue({
      taskSync: {
        created: [],
        updated: [],
        totalCandidates: 0,
        tasks: [],
      },
      planningSync: { addedSteps: [], updatedSteps: [] },
      planChanged: false,
      workspaceResult: undefined,
      createdWorkspacePhase: false,
      createdWorkspaceReviewStep: false,
      updatedWorkspaceNotes: false,
    });
    const handler = await planRecoverRecentWorkModule.createHandler();
    const result = await handler.execute(
      {},
      makeCtx({ planningService: { name: 'svc' } } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('No additional planning mutations were needed.');
    }
    expect(publishPlanningStateToRendererMock).not.toHaveBeenCalled();
  });

  it('orchestrator throws → DOMAIN_ERROR', async () => {
    recoverRecentWorkIntoPlanningMock.mockRejectedValue(new Error('boom'));
    const handler = await planRecoverRecentWorkModule.createHandler();
    const result = await handler.execute(
      {},
      makeCtx({ planningService: { name: 'svc' } } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('boom');
    }
  });
});
