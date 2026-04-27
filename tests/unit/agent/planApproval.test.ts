// ============================================================================
// PlanApprovalGate Tests
// 覆盖风险评估、auto-approve fast-path、approve/reject 正向路径、
// timeout fail-closed 自动拒绝、serial queue 顺序
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// TeammateService 只负责把 review 推给 coordinator — 测试场景不关心递送
vi.mock('../../../src/main/agent/teammate/teammateService', () => ({
  getTeammateService: () => ({
    sendPlanReview: vi.fn(),
  }),
}));

// EventBus 只收集事件，不做业务断言
const busState = vi.hoisted(() => ({
  publishMock: vi.fn(),
}));

vi.mock('../../../src/main/services/eventing/bus', () => ({
  getEventBus: () => ({
    publish: busState.publishMock,
  }),
}));

// isDangerousCommand — 用真实逻辑即可，但为隔离副作用这里桩一个
vi.mock('../../../src/main/services/core/permissionPresets', () => ({
  isDangerousCommand: (cmd: string) =>
    /\brm\s+-rf?\b/.test(cmd) || /\bsudo\b/.test(cmd),
}));

import {
  PlanApprovalGate,
  type RiskAssessment,
} from '../../../src/main/agent/planApproval';

type ToolRequest = {
  tool?: string;
  command?: string;
  path?: string;
};

function makeGate(timeoutMs = 1_000): PlanApprovalGate {
  return new PlanApprovalGate({ approvalTimeoutMs: timeoutMs });
}

function makeSubmission(
  risk: RiskAssessment,
  overrides: Partial<{
    agentId: string;
    agentName: string;
    coordinatorId: string;
    plan: string;
  }> = {}
) {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    agentName: overrides.agentName ?? 'Coder',
    coordinatorId: overrides.coordinatorId ?? 'coord',
    plan: overrides.plan ?? 'rm old build artifacts',
    risk,
  };
}

describe('PlanApprovalGate', () => {
  let gate: PlanApprovalGate;

  beforeEach(() => {
    busState.publishMock.mockReset();
    gate = makeGate(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // 风险评估
  // ==========================================================================

  describe('assessRisk', () => {
    it('无危险因素时返回 low', () => {
      const request: ToolRequest = { tool: 'Read', path: '/repo/src/foo.ts' };
      const risk = gate.assessRisk(request as never, '/repo');
      expect(risk.level).toBe('low');
      expect(risk.reasons).toEqual([]);
    });

    it('单一危险命令判为 medium', () => {
      const request: ToolRequest = { tool: 'Bash', command: 'sudo apt update' };
      const risk = gate.assessRisk(request as never);
      expect(risk.level).toBe('medium');
      expect(risk.reasons.length).toBe(1);
    });

    it('rm -rf 同时触发 dangerous 和 deletion，升级为 high', () => {
      const request: ToolRequest = { tool: 'Bash', command: 'rm -rf /tmp/x' };
      const risk = gate.assessRisk(request as never);
      expect(risk.level).toBe('high');
      expect(risk.reasons.length).toBeGreaterThanOrEqual(2);
    });

    it('写入工作目录外升级风险', () => {
      const request: ToolRequest = { tool: 'Write', path: '/etc/passwd' };
      const risk = gate.assessRisk(request as never, '/repo');
      expect(risk.level).toBe('medium');
      expect(risk.reasons.some((r) => r.includes('outside'))).toBe(true);
    });

    it('没有 workingDirectory 时不检查路径越界', () => {
      const request: ToolRequest = { tool: 'Write', path: '/anywhere' };
      const risk = gate.assessRisk(request as never);
      expect(risk.level).toBe('low');
    });
  });

  // ==========================================================================
  // Auto-approve fast-path
  // ==========================================================================

  describe('低风险 auto-approve', () => {
    it('low risk 立即 auto-approve 不进入队列', async () => {
      const result = await gate.submitForApproval(
        makeSubmission({ level: 'low', reasons: [] })
      );
      expect(result).toEqual({ approved: true, autoApproved: true });
      expect(gate.getPendingPlans()).toHaveLength(0);
      // 未触发事件总线
      expect(busState.publishMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 外部 approve / reject
  // ==========================================================================

  describe('审批流', () => {
    it('medium risk 提交后等待外部 approve()', async () => {
      vi.useFakeTimers();

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['Dangerous command: sudo apt'] })
      );

      // 让 approvalQueue 的 then 链跑起来把 plan 入队
      await vi.advanceTimersByTimeAsync(0);

      const plans = gate.getPendingPlans();
      expect(plans).toHaveLength(1);
      const planId = plans[0].id;

      expect(gate.approve(planId, 'looks good')).toBe(true);

      // 推进过一次 poll interval（500ms）让 waitForApproval 感知状态变化
      await vi.advanceTimersByTimeAsync(600);

      const result = await pending;
      expect(result.approved).toBe(true);
      expect(result.feedback).toBe('looks good');
      expect(result.autoApproved).toBe(false);
    });

    it('medium risk 提交后被外部 reject()', async () => {
      vi.useFakeTimers();

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r1'] })
      );
      await vi.advanceTimersByTimeAsync(0);

      const planId = gate.getPendingPlans()[0].id;
      expect(gate.reject(planId, 'too risky')).toBe(true);

      await vi.advanceTimersByTimeAsync(600);

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.feedback).toBe('too risky');
      expect(result.autoApproved).toBe(false);
    });

    it('approve 已结算的 plan 返回 false', async () => {
      vi.useFakeTimers();

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r'] })
      );
      await vi.advanceTimersByTimeAsync(0);

      const planId = gate.getPendingPlans()[0].id;
      gate.approve(planId, 'ok');

      // 第二次 approve 应该被拒
      expect(gate.approve(planId, 'again')).toBe(false);
      // 改 reject 也一样
      expect(gate.reject(planId, 'flip')).toBe(false);

      await vi.advanceTimersByTimeAsync(600);
      await pending;
    });

    it('approve / reject 未知 planId 返回 false', () => {
      expect(gate.approve('plan_nonexistent')).toBe(false);
      expect(gate.reject('plan_nonexistent', 'reason')).toBe(false);
    });

    it('提交后会通过 EventBus 广播 plan_review 事件', async () => {
      vi.useFakeTimers();

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'high', reasons: ['r1', 'r2'] })
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(busState.publishMock).toHaveBeenCalled();
      const call = busState.publishMock.mock.calls[0];
      expect(call[0]).toBe('swarm');
      expect(call[1]).toBe('agent:plan_review');

      // 收尾：批准让 promise 结算不留挂单
      gate.approve(gate.getPendingPlans()[0].id);
      await vi.advanceTimersByTimeAsync(600);
      await pending;
    });
  });

  // ==========================================================================
  // Timeout fail-closed
  // ==========================================================================

  describe('超时 fail-closed', () => {
    it('high risk 超时后自动 reject 且 autoApproved=true', async () => {
      vi.useFakeTimers();
      gate = makeGate(800);

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'high', reasons: ['rm -rf', 'outside cwd'] })
      );

      // 推进过超时 + 一个 poll tick
      await vi.advanceTimersByTimeAsync(1_500);

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.autoApproved).toBe(true);
      expect(result.feedback).toMatch(/Auto-rejected after timeout/);
      expect(result.feedback).toMatch(/risk: high/);
    });

    it('medium risk 超时也 fail-closed（非无人值守放行）', async () => {
      vi.useFakeTimers();
      gate = makeGate(800);

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r1'] })
      );
      await vi.advanceTimersByTimeAsync(1_500);

      const result = await pending;
      expect(result.approved).toBe(false);
      expect(result.autoApproved).toBe(true);
    });

    it('超时后 plan 状态被更新为 rejected 持久化', async () => {
      vi.useFakeTimers();
      gate = makeGate(800);

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'high', reasons: ['a', 'b'] })
      );
      await vi.advanceTimersByTimeAsync(0);
      const planId = gate.getPendingPlans()[0].id;

      await vi.advanceTimersByTimeAsync(1_500);
      await pending;

      const plan = gate.getPlan(planId);
      expect(plan?.status).toBe('rejected');
      expect(plan?.feedback).toMatch(/Auto-rejected/);
      expect(plan?.resolvedAt).toBeTypeOf('number');
    });
  });

  // ==========================================================================
  // Serial queue 顺序
  // ==========================================================================

  describe('serial queue', () => {
    it('并发提交被 approvalQueue 串行化：一个处理完才开始下一个', async () => {
      vi.useFakeTimers();

      const firstPending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r'] }, { agentId: 'a1' })
      );
      const secondPending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r'] }, { agentId: 'a2' })
      );

      // 让第一条入队
      await vi.advanceTimersByTimeAsync(0);

      // 第一时间只有第一条 plan 是 pending
      let pendingList = gate.getPendingPlans();
      expect(pendingList).toHaveLength(1);
      expect(pendingList[0].agentId).toBe('a1');

      // 解决第一条
      gate.approve(pendingList[0].id);
      await vi.advanceTimersByTimeAsync(600);
      await firstPending;

      // 第二条现在进入 pending
      await vi.advanceTimersByTimeAsync(0);
      pendingList = gate.getPendingPlans();
      expect(pendingList).toHaveLength(1);
      expect(pendingList[0].agentId).toBe('a2');

      gate.approve(pendingList[0].id);
      await vi.advanceTimersByTimeAsync(600);
      await secondPending;
    });
  });

  // ==========================================================================
  // Query helpers
  // ==========================================================================

  describe('query', () => {
    it('getPendingPlans 过滤掉已结算的 plan', async () => {
      vi.useFakeTimers();

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r'] })
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(gate.getPendingPlans()).toHaveLength(1);
      gate.approve(gate.getPendingPlans()[0].id);
      expect(gate.getPendingPlans()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(600);
      await pending;
    });

    it('getPlan 返回指定 id 的 submission 快照', async () => {
      vi.useFakeTimers();

      const pending = gate.submitForApproval(
        makeSubmission({ level: 'medium', reasons: ['r1'] })
      );
      await vi.advanceTimersByTimeAsync(0);

      const planId = gate.getPendingPlans()[0].id;
      const plan = gate.getPlan(planId);
      expect(plan?.status).toBe('pending');
      expect(plan?.risk.level).toBe('medium');
      expect(plan?.risk.reasons).toEqual(['r1']);

      gate.approve(planId);
      await vi.advanceTimersByTimeAsync(600);
      await pending;
    });
  });
});
