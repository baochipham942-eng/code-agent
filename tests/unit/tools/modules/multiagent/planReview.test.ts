// ============================================================================
// PlanReview (native ToolModule) Tests — Wave 3 multiagent
//
// 关键覆盖：
// - schema 字段名 / required / readOnly / allowInPlanMode 对齐
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - approve / reject 行为保真：legacy 输出文案 1:1 复刻
// - reject 必须带 feedback；plan 不存在 → NOT_FOUND；非 pending → DOMAIN_ERROR
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

const getPlanApprovalGateMock = vi.fn();

vi.mock('../../../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => getPlanApprovalGateMock(),
}));

import { planReviewModule } from '../../../../../src/host/tools/modules/multiagent/planReview';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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

interface MockGate {
  getPlan: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
}

function makeMockGate(overrides: Partial<MockGate> = {}): MockGate {
  return {
    getPlan: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

describe('plan_review schema', () => {
  it('对齐 legacy schema 名/required/readOnly/allowInPlanMode', () => {
    expect(planReviewModule.schema.name).toBe('plan_review');
    expect(planReviewModule.schema.inputSchema.required).toEqual(['plan_id', 'action']);
    expect(planReviewModule.schema.category).toBe('multiagent');
    expect(planReviewModule.schema.permissionLevel).toBe('read');
    expect(planReviewModule.schema.readOnly).toBe(true);
    expect(planReviewModule.schema.allowInPlanMode).toBe(true);
    const props = planReviewModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(['approve', 'reject']);
  });
});

// -----------------------------------------------------------------------------
// 错误码 / 五链
// -----------------------------------------------------------------------------

describe('plan_review behavior', () => {
  it('缺 plan_id 或 action 返回 INVALID_ARGS', async () => {
    const handler = await planReviewModule.createHandler();
    const r1 = await handler.execute({ action: 'approve' }, makeCtx(), allowAll);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe('INVALID_ARGS');
    }
    const r2 = await handler.execute({ plan_id: 'p1' }, makeCtx(), allowAll);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('INVALID_ARGS');
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'p1', action: 'approve' },
      makeCtx(),
      denyAll,
    );
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
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'p1', action: 'approve' },
      ctx,
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('plan 不存在 → NOT_FOUND', async () => {
    const gate = makeMockGate({ getPlan: vi.fn().mockReturnValue(undefined) });
    getPlanApprovalGateMock.mockReturnValue(gate);
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'missing', action: 'approve' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('Plan not found');
    }
  });

  it('plan 非 pending → DOMAIN_ERROR', async () => {
    const gate = makeMockGate({
      getPlan: vi.fn().mockReturnValue({ id: 'p1', agentName: 'A', status: 'approved' }),
    });
    getPlanApprovalGateMock.mockReturnValue(gate);
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'p1', action: 'approve' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('DOMAIN_ERROR');
      expect(result.error).toContain('already approved');
    }
  });

  it('reject 缺 feedback → INVALID_ARGS', async () => {
    const gate = makeMockGate({
      getPlan: vi.fn().mockReturnValue({ id: 'p1', agentName: 'A', status: 'pending' }),
    });
    getPlanApprovalGateMock.mockReturnValue(gate);
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'p1', action: 'reject' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Feedback is required');
    }
  });

  it('happy path approve（含 feedback）调用 gate.approve 并返回 1:1 文案', async () => {
    const gate = makeMockGate({
      getPlan: vi.fn().mockReturnValue({ id: 'p1', agentName: 'Coder', status: 'pending' }),
    });
    getPlanApprovalGateMock.mockReturnValue(gate);
    const handler = await planReviewModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      { plan_id: 'p1', action: 'approve', feedback: 'looks good' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Plan p1 approved for Coder. Feedback: looks good');
    }
    expect(gate.approve).toHaveBeenCalledWith('p1', 'looks good');
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'plan_review' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('happy path reject 调用 gate.reject 并返回 1:1 文案', async () => {
    const gate = makeMockGate({
      getPlan: vi.fn().mockReturnValue({ id: 'p2', agentName: 'Plan', status: 'pending' }),
    });
    getPlanApprovalGateMock.mockReturnValue(gate);
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'p2', action: 'reject', feedback: 'too risky' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Plan p2 rejected for Plan. Reason: too risky');
    }
    expect(gate.reject).toHaveBeenCalledWith('p2', 'too risky');
  });

  it('未知 action → INVALID_ARGS', async () => {
    const gate = makeMockGate({
      getPlan: vi.fn().mockReturnValue({ id: 'p1', agentName: 'A', status: 'pending' }),
    });
    getPlanApprovalGateMock.mockReturnValue(gate);
    const handler = await planReviewModule.createHandler();
    const result = await handler.execute(
      { plan_id: 'p1', action: 'cancel' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Invalid action');
    }
  });
});
