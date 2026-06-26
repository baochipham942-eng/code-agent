// ============================================================================
// PlanRead (native ToolModule) Tests — Wave 3 planning
//
// 关键覆盖：
// - schema 字段名 / required / readOnly / allowInPlanMode 对齐
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - opaque ctx.planningService cast: 缺 service 时返回成功 + 提示文案
// - summary mode / full mode 行为 1:1 复刻
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

import { planReadModule } from '../../../../../src/host/tools/modules/planning/planRead';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test',
    workingDir: '/tmp/test',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

interface MockPlanningService {
  plan: {
    read: ReturnType<typeof vi.fn>;
    getCurrentTask: ReturnType<typeof vi.fn>;
    getNextPendingTask: ReturnType<typeof vi.fn>;
    isComplete: ReturnType<typeof vi.fn>;
  };
}

function makeMockService(planRead: unknown): MockPlanningService {
  return {
    plan: {
      read: vi.fn().mockResolvedValue(planRead),
      getCurrentTask: vi.fn().mockReturnValue(undefined),
      getNextPendingTask: vi.fn().mockReturnValue(undefined),
      isComplete: vi.fn().mockReturnValue(false),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('plan_read schema', () => {
  it('对齐 legacy schema 名/category/readOnly/allowInPlanMode', () => {
    expect(planReadModule.schema.name).toBe('plan_read');
    expect(planReadModule.schema.category).toBe('planning');
    expect(planReadModule.schema.permissionLevel).toBe('read');
    expect(planReadModule.schema.readOnly).toBe(true);
    expect(planReadModule.schema.allowInPlanMode).toBe(true);
    const props = planReadModule.schema.inputSchema.properties as Record<string, unknown>;
    expect(props.includeCompleted).toBeDefined();
    expect(props.summary).toBeDefined();
  });
});

describe('plan_read behavior', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await planReadModule.createHandler();
    const result = await handler.execute({}, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERMISSION_DENIED');
      expect(result.error).toContain('blocked');
    }
  });

  it('已 abort 的 ctx → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = makeCtx({ abortSignal: ctrl.signal });
    const handler = await planReadModule.createHandler();
    const result = await handler.execute({}, ctx, allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('缺 planningService → ok true with fallback message', async () => {
    const handler = await planReadModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('No planning service available.');
      expect(result.output).toContain('To create a plan, use plan_update tool.');
    }
  });

  it('plan 不存在 → ok true with hint', async () => {
    const service = makeMockService(null);
    const handler = await planReadModule.createHandler();
    const result = await handler.execute(
      {},
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('No plan exists yet.');
    }
  });

  it('summary mode 输出 1:1 复刻 legacy（含 Current 行）', async () => {
    const plan = {
      title: 'Demo Plan',
      objective: 'Do stuff',
      metadata: { totalSteps: 5, completedSteps: 2, blockedSteps: 0 },
      phases: [],
    };
    const service = makeMockService(plan);
    service.plan.getCurrentTask.mockReturnValue({ step: { content: 'Implement login' } });
    const handler = await planReadModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { summary: true },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('**Demo Plan**');
      expect(result.output).toContain('Progress: 2/5 steps');
      expect(result.output).toContain('Current: Implement login');
    }
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'plan_read' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('summary mode 无 current/next 但 isComplete → "All tasks completed!"', async () => {
    const plan = {
      title: 'Done',
      objective: 'finished',
      metadata: { totalSteps: 3, completedSteps: 3, blockedSteps: 0 },
      phases: [],
    };
    const service = makeMockService(plan);
    service.plan.isComplete.mockReturnValue(true);
    const handler = await planReadModule.createHandler();
    const result = await handler.execute(
      { summary: true },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Status: All tasks completed!');
    }
  });

  it('full mode 输出 phases + STATUS_ICONS', async () => {
    const plan = {
      title: 'P',
      objective: 'O',
      metadata: { totalSteps: 2, completedSteps: 1, blockedSteps: 1 },
      phases: [
        {
          id: 'ph1',
          title: 'Phase A',
          status: 'in_progress',
          notes: 'note A',
          steps: [
            { id: 's1', content: 'step1 done', status: 'completed' },
            { id: 's2', content: 'step2 todo', status: 'pending' },
          ],
        },
      ],
    };
    const service = makeMockService(plan);
    const handler = await planReadModule.createHandler();
    const result = await handler.execute(
      { includeCompleted: false },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('# P');
      expect(result.output).toContain('**Objective:** O');
      expect(result.output).toContain('**Skipped:** 1 steps');
      expect(result.output).toContain('## ◐ Phase A');
      expect(result.output).toContain('> note A');
      // step1 (completed) hidden because includeCompleted=false
      expect(result.output).not.toContain('step1 done');
      expect(result.output).toContain('- [ ] ○ step2 todo');
    }
  });

  it('full mode includeCompleted=true 显示 completed steps', async () => {
    const plan = {
      title: 'P',
      objective: 'O',
      metadata: { totalSteps: 1, completedSteps: 1, blockedSteps: 0 },
      phases: [
        {
          id: 'ph1',
          title: 'Phase A',
          status: 'completed',
          steps: [{ id: 's1', content: 'done step', status: 'completed' }],
        },
      ],
    };
    const service = makeMockService(plan);
    const handler = await planReadModule.createHandler();
    const result = await handler.execute(
      { includeCompleted: true },
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('- [x] ● done step');
    }
  });

  it('planningService throws → DOMAIN_ERROR', async () => {
    const service = {
      plan: {
        read: vi.fn().mockRejectedValue(new Error('oh no')),
        getCurrentTask: vi.fn(),
        getNextPendingTask: vi.fn(),
        isComplete: vi.fn(),
      },
    };
    const handler = await planReadModule.createHandler();
    const result = await handler.execute(
      {},
      makeCtx({ planningService: service } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('Failed to read plan: oh no');
    }
  });
});
