// ============================================================================
// PlanFacade (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

// Mocks for sub-tools' downstream services
const recoverRecentWorkIntoPlanningMock = vi.fn();
const publishPlanningStateToRendererMock = vi.fn();

vi.mock('../../../../../src/main/planning/recoveredWorkOrchestrator', () => ({
  recoverRecentWorkIntoPlanning: (...a: unknown[]) => recoverRecentWorkIntoPlanningMock(...a),
  WORKSPACE_RECOVERY_PHASE_TITLE: 'Recovered Workspace Activity',
}));
vi.mock('../../../../../src/main/planning', () => ({
  publishPlanningStateToRenderer: (...a: unknown[]) => publishPlanningStateToRendererMock(...a),
}));
vi.mock('../../../../../src/main/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    recordTodoFeedbackForTask: vi.fn(),
    recordTodoFeedback: vi.fn(),
    clearTodoFeedbackForTask: vi.fn(),
    clearTodoFeedback: vi.fn(),
  }),
  isDesktopDerivedSessionTask: () => false,
}));
vi.mock('../../../../../src/main/desktop/workspaceActivitySearchService', () => ({
  recordWorkspaceActivityFeedback: vi.fn(),
  clearWorkspaceActivityFeedback: vi.fn(),
}));
vi.mock('../../../../../src/main/services/planning/taskStore', () => ({
  listTasks: vi.fn().mockReturnValue([]),
}));

import { planFacadeModule } from '../../../../../src/main/tools/modules/planning/planFacade';

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
});

describe('Plan facade schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(planFacadeModule.schema.name).toBe('Plan');
    expect(planFacadeModule.schema.category).toBe('planning');
    expect(planFacadeModule.schema.permissionLevel).toBe('write');
    expect(planFacadeModule.schema.allowInPlanMode).toBe(true);
    expect(planFacadeModule.schema.inputSchema.required).toEqual(['action']);
    const props = planFacadeModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(['read', 'update', 'recover_recent_work']);
  });
});

describe('Plan facade dispatch', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await planFacadeModule.createHandler();
    const result = await handler.execute({ action: 'read' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await planFacadeModule.createHandler();
    const result = await handler.execute(
      { action: 'read' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('未知 action → INVALID_ARGS', async () => {
    const handler = await planFacadeModule.createHandler();
    const result = await handler.execute({ action: 'bogus' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Unknown action');
    }
  });

  it('action=read 缺 service → 提示文案 (复刻 plan_read fallback)', async () => {
    const handler = await planFacadeModule.createHandler();
    const result = await handler.execute({ action: 'read' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('No planning service available');
  });

  it('action=update 缺 stepContent → INVALID_ARGS (复刻 plan_update)', async () => {
    const handler = await planFacadeModule.createHandler();
    const result = await handler.execute(
      { action: 'update', status: 'completed' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('stepContent');
    }
  });

  it('action=recover_recent_work 缺 planningService → NOT_INITIALIZED', async () => {
    const handler = await planFacadeModule.createHandler();
    const result = await handler.execute(
      { action: 'recover_recent_work' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
  });
});
