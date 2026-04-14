// ============================================================================
// Cancel Correctness Tests — ADR-010 item #6
// ============================================================================
//
// 验证 swarm 取消后系统整体状态的一致性：
//   - PlanApprovalGate.pendingResolvers 清空，高风险 plan 的 submitForApproval
//     立即 settle（rejected，而非挂起到 timeout）
//   - SwarmLaunchApprovalGate.pendingResolvers 清空，requestApproval 立即 settle
//   - SpawnGuard.cancelAll 触发每个 running agent 的 AbortController，并把状态
//     置 cancelled 释放配额
//   - ParallelAgentCoordinator.reset 清空 sharedContext 无 stale 残留
//
// 范围边界：
//   - 这里只打 gate 直接的行为单元，不拉 agentSwarm（agentSwarm 是 wire 层，
//     组合 gate 的 cancelAll，其对称性通过跑 swarm 集成测试覆盖）。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/agent/teammate/teammateService', () => ({
  getTeammateService: () => ({
    sendPlanReview: vi.fn(),
  }),
}));

vi.mock('../../../src/main/protocol/events/bus', () => ({
  getEventBus: () => ({ publish: vi.fn() }),
}));

vi.mock('../../../src/main/services/core/permissionPresets', () => ({
  isDangerousCommand: (cmd: string) => /\brm\s+-rf?\b/.test(cmd),
}));

vi.mock('../../../src/main/platform', () => ({
  BrowserWindow: {
    // 返回非空数组，避免 launch approval 走 headless auto-approve fast path
    getAllWindows: () => [{}],
  },
}));

import { PlanApprovalGate } from '../../../src/main/agent/planApproval';
import { SwarmLaunchApprovalGate } from '../../../src/main/agent/swarmLaunchApproval';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/main/agent/spawnGuard';

// ---------------------------------------------------------------------------
// PlanApprovalGate.cancelAll
// ---------------------------------------------------------------------------

describe('PlanApprovalGate.cancelAll — ADR-010 #6', () => {
  it('排干 pendingResolvers，pending submitForApproval 立即 settle 为 rejected', async () => {
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });

    const p1 = gate.submitForApproval({
      agentId: 'a1',
      agentName: 'worker-1',
      coordinatorId: 'c',
      plan: 'delete build dir',
      risk: { level: 'high', reasons: ['rm -rf'] },
    });

    // 让 approvalQueue 跑完首 microtask，submission 真正入 pendingPlans/pendingResolvers
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.getPendingResolverCount()).toBe(1);

    const cancelled = gate.cancelAll('swarm_cancelled');
    expect(cancelled).toBe(1);
    expect(gate.getPendingResolverCount()).toBe(0);

    const r1 = await p1;
    expect(r1.approved).toBe(false);
    expect(r1.feedback).toContain('swarm_cancelled');
    expect(gate.getPendingPlans()).toHaveLength(0);
  });

  it('串行 approvalQueue 中的两条 submission 被先后 cancel，最终都 rejected', async () => {
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });

    const p1 = gate.submitForApproval({
      agentId: 'a1',
      agentName: 'worker-1',
      coordinatorId: 'c',
      plan: 'delete build dir',
      risk: { level: 'high', reasons: ['rm -rf'] },
    });
    const p2 = gate.submitForApproval({
      agentId: 'a2',
      agentName: 'worker-2',
      coordinatorId: 'c',
      plan: 'write outside cwd',
      risk: { level: 'medium', reasons: ['write outside working dir'] },
    });

    // 先让第一条进入 pendingResolvers
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.getPendingResolverCount()).toBe(1);

    // 第一次 cancel：排干第一条
    gate.cancelAll('swarm_cancelled');
    const r1 = await p1;
    expect(r1.approved).toBe(false);

    // 第一条 settle 后 approvalQueue 解锁，第二条入 pendingResolvers
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.getPendingResolverCount()).toBe(1);

    // 第二次 cancel：排干第二条
    gate.cancelAll('swarm_cancelled');
    const r2 = await p2;
    expect(r2.approved).toBe(false);
    expect(r2.feedback).toContain('swarm_cancelled');

    expect(gate.getPendingResolverCount()).toBe(0);
    expect(gate.getPendingPlans()).toHaveLength(0);
  });

  it('cancelAll 在无 pending 时 no-op，返回 0', () => {
    const gate = new PlanApprovalGate();
    expect(gate.cancelAll('whatever')).toBe(0);
    expect(gate.getPendingResolverCount()).toBe(0);
  });

  it('已 resolved 的 plan 不被 cancelAll 二次翻转', async () => {
    const gate = new PlanApprovalGate({ approvalTimeoutMs: 60_000 });
    const p = gate.submitForApproval({
      agentId: 'a1',
      agentName: 'worker-1',
      coordinatorId: 'c',
      plan: 'rm -rf old',
      risk: { level: 'high', reasons: ['rm -rf'] },
    });

    await Promise.resolve();
    await Promise.resolve();

    const pendingBefore = gate.getPendingPlans();
    expect(pendingBefore).toHaveLength(1);
    const planId = pendingBefore[0].id;

    // 先正常 approve
    expect(gate.approve(planId, 'ok')).toBe(true);
    const result = await p;
    expect(result.approved).toBe(true);

    // 现在 cancelAll 不应触碰已 approved 的 plan
    const cancelled = gate.cancelAll('swarm_cancelled');
    expect(cancelled).toBe(0);
    const plan = gate.getPlan(planId);
    expect(plan?.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// SwarmLaunchApprovalGate.cancelAll
// ---------------------------------------------------------------------------

describe('SwarmLaunchApprovalGate.cancelAll — ADR-010 #6', () => {
  it('排干 pendingResolvers，pending requestApproval 立即 settle 为 rejected', async () => {
    const gate = new SwarmLaunchApprovalGate({ approvalTimeoutMs: 60_000 });

    const pending = gate.requestApproval({
      tasks: [
        { id: 't1', role: 'worker', task: 'do it', tools: ['Read'], writeAccess: true, dependsOn: [] },
      ],
      summary: 'test launch',
    });

    // request 在首个 microtask 后写入 pendingResolvers
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.getPendingResolverCount()).toBe(1);

    const cancelled = gate.cancelAll('swarm_cancelled');
    expect(cancelled).toBe(1);
    expect(gate.getPendingResolverCount()).toBe(0);

    const result = await pending;
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain('swarm_cancelled');
  });

  it('cancelAll 在无 pending 时 no-op', () => {
    const gate = new SwarmLaunchApprovalGate();
    expect(gate.cancelAll('whatever')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SpawnGuard.cancelAll
// ---------------------------------------------------------------------------

describe('SpawnGuard.cancelAll — ADR-010 #6', () => {
  beforeEach(() => {
    resetSpawnGuard();
  });

  it('触发所有 running agent 的 AbortController，释放配额', () => {
    const guard = getSpawnGuard({ maxAgents: 6 });

    // 模拟两个 running agent
    const aborts = [new AbortController(), new AbortController()];
    for (let i = 0; i < 2; i += 1) {
      const never = new Promise<never>(() => {}) as unknown as Promise<import('../../../src/main/agent/subagentExecutor').SubagentResult>;
      guard.register(`agent-${i}`, 'worker', 'test', never, aborts[i]);
    }

    expect(guard.getRunningCount()).toBe(2);

    const cancelled = guard.cancelAll('swarm_cancelled');
    expect(cancelled).toBe(2);
    expect(guard.getRunningCount()).toBe(0);

    for (const controller of aborts) {
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe('swarm_cancelled');
    }

    const agents = guard.list();
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent.status).toBe('cancelled');
      expect(agent.completedAt).toBeDefined();
    }
  });

  it('cancelAll 跳过已经 completed/failed 的 agent', () => {
    const guard = getSpawnGuard();

    const successController = new AbortController();
    const finished: import('../../../src/main/agent/subagentExecutor').SubagentResult = {
      success: true,
      output: 'done',
      iterations: 1,
      toolsUsed: [],
      cost: 0,
    };
    guard.register('agent-done', 'worker', 'test', Promise.resolve(finished), successController);
    // 等 promise.then 切换 agent 状态
    return Promise.resolve().then(() => {
      const cancelled = guard.cancelAll('swarm_cancelled');
      expect(cancelled).toBe(0);
      const agent = guard.get('agent-done');
      expect(agent?.status).toBe('completed');
    });
  });

  it('cancelAll 在无 running agent 时 no-op', () => {
    const guard = getSpawnGuard();
    expect(guard.cancelAll('whatever')).toBe(0);
  });
});

// ParallelAgentCoordinator.reset() 已经在
// tests/unit/agent/parallelAgentCoordinator.test.ts 的 'reset 清空 completed
// tasks / shared context / listeners' 用例里覆盖，不再重复。
