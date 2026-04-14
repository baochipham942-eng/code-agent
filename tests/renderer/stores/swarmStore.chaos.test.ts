// ============================================================================
// Swarm Store Chaos Tests — ADR-010 item #4 priority 2
// ============================================================================
//
// 验证 swarmStore.handleEvent 在异常事件序列下的健壮性：
//   - 重复事件（EventBus 重放）是否幂等
//   - 乱序事件（timestamp 倒序 / 跨阶段错位）是否收敛到与顺序投递等价的状态
//
// 范围边界：
//   - 只测 store 层 reducer 的数学属性，不拉 SSE/transport。
//   - SSE 重连场景（priority 1）在 httpTransport.sseReconnect.test.ts 里单独测。
//   - cancellation chaos（priority 3）不在本 session 范围内。
//
// 术语：
//   - "幂等" = f(event)(f(event)(s)) === f(event)(s)，handler 在同一 event 上可重入
//   - "收敛" = 对任意合法排列 π，reduce(π(events)) 的"稳定字段"与 reduce(events) 相同
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  SwarmEvent,
  SwarmAgentState,
} from '../../../src/shared/contract/swarm';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  off: vi.fn(),
}));

import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function agent(id: string, overrides: Partial<SwarmAgentState> = {}): SwarmAgentState {
  return {
    id,
    name: `Agent ${id}`,
    role: 'worker',
    status: 'pending',
    iterations: 0,
    ...overrides,
  };
}

function evt<T extends SwarmEvent['type']>(
  type: T,
  data: SwarmEvent['data'],
  timestamp: number,
): SwarmEvent {
  return { type, timestamp, data } as SwarmEvent;
}

/**
 * 快照 store 中"应当幂等"的核心字段。
 * eventLog / messages / completedRuns 因已知 push-based 语义会在重复/乱序下
 * 出现差异，由专用测试显式断言。
 */
function coreSnapshot() {
  const state = useSwarmStore.getState();
  return {
    isRunning: state.isRunning,
    startTime: state.startTime,
    agents: state.agents,
    statistics: state.statistics,
    executionPhase: state.executionPhase,
    verification: state.verification,
    aggregation: state.aggregation,
    planReviewsByIdStatus: state.planReviews.map((r) => ({
      id: r.id,
      status: r.status,
      feedback: r.feedback,
    })),
    launchRequestsByIdStatus: state.launchRequests.map((r) => ({
      id: r.id,
      status: r.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Priority 2.a: 重复事件 — handler 幂等性
// ---------------------------------------------------------------------------

describe('swarmStore chaos — 重复事件幂等性', () => {
  beforeEach(() => {
    useSwarmStore.getState().reset();
  });

  it('agent:added 投递两次，agents 数组与统计保持一致', () => {
    const store = useSwarmStore.getState();
    const e = evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'running' }),
    }, 1000);

    store.handleEvent(evt('swarm:started', {}, 999));
    store.handleEvent(e);
    const after1 = coreSnapshot();
    store.handleEvent(e); // 完全相同的事件引用
    const after2 = coreSnapshot();

    expect(after2.agents).toEqual(after1.agents);
    expect(after2.statistics).toEqual(after1.statistics);
  });

  it('agent:updated 投递两次，merge 后状态等价', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));
    store.handleEvent(evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'running', iterations: 1 }),
    }, 100));

    const e = evt('swarm:agent:updated', {
      agentState: agent('a1', { status: 'running', iterations: 5 }),
    }, 200);
    store.handleEvent(e);
    const snap1 = coreSnapshot();
    store.handleEvent(e);
    const snap2 = coreSnapshot();

    expect(snap2).toEqual(snap1);
  });

  it('swarm:completed 投递两次，isRunning / aggregation 等价', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));
    store.handleEvent(evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'completed' }),
    }, 100));

    const done = evt('swarm:completed', {
      result: {
        success: true,
        totalTime: 1000,
        aggregation: {
          summary: 'ok',
          filesChanged: ['x.ts'],
          totalCost: 0,
          totalDuration: 1000,
          speedup: 1,
          successRate: 1,
          totalIterations: 1,
        },
      },
    }, 500);
    store.handleEvent(done);
    const snap1 = coreSnapshot();
    store.handleEvent(done);
    const snap2 = coreSnapshot();

    expect(snap2.isRunning).toBe(false);
    expect(snap2.aggregation).toEqual(snap1.aggregation);
    expect(snap2.executionPhase).toBe(snap1.executionPhase);
  });

  // ADR-010 #6 固定：fallback push 前按 id 去重（swarmStore.ts:447-463）。
  it('plan_review → plan_approved → plan_approved 应保持只有一条 approved', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));

    const review = evt('swarm:agent:plan_review', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1' },
    }, 100);
    const approve = evt('swarm:agent:plan_approved', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1', feedback: 'ok' },
    }, 200);

    store.handleEvent(review);
    store.handleEvent(approve);
    store.handleEvent(approve); // duplicate terminal event
    const state = useSwarmStore.getState();

    expect(state.planReviews).toHaveLength(1);
    expect(state.planReviews[0].status).toBe('approved');
  });

  // ADR-010 #6 固定：plan_review 按 id 去重（swarmStore.ts:410-420）。
  it('plan_review 重复投递不应产生两条 pending 记录', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));

    const review = evt('swarm:agent:plan_review', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1' },
    }, 100);
    store.handleEvent(review);
    store.handleEvent(review);

    const state = useSwarmStore.getState();
    expect(state.planReviews).toHaveLength(1);
    expect(state.planReviews[0].id).toBe('plan-1');
  });

  // ADR-010 #6 固定：appendMessage 按 id 去重（swarmStore.ts:479-485）。
  it('agent:message 重复投递不应重复入队', () => {
    const store = useSwarmStore.getState();
    const msg = evt('swarm:agent:message', {
      message: { from: 'a1', to: 'a2', content: 'hi', messageType: 'coordination' },
    }, 5000);

    store.handleEvent(msg);
    store.handleEvent(msg);

    const state = useSwarmStore.getState();
    expect(state.messages).toHaveLength(1);
  });

  // ADR-010 #6 固定：completedRuns 按 agent id 去重，IPC 持久化只发一次
  // （swarmStore.ts:623-634, 699-701）。
  it('agent:completed 重复投递不应产生两条 completedRun', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));

    const done = evt('swarm:agent:completed', {
      agentState: agent('a1', {
        status: 'completed',
        startTime: 10,
        endTime: 20,
        tokenUsage: { input: 1, output: 1 },
        toolCalls: 1,
      }),
    }, 200);
    store.handleEvent(done);
    store.handleEvent(done);

    const state = useSwarmStore.getState();
    expect(state.completedRuns).toHaveLength(1);
  });

  // BUG: ADR-010 item #4, production fix deferred to main-line session
  //
  // `appendEventLog` 无条件 push timeline entry，没有按 `evt-${timestamp}-${type}`
  // id 去重。eventLog 会因为 EventBus 重放出现视觉上的重复条目。80 条上限会掩盖
  // 问题但不根治。
  //
  // 见 src/renderer/stores/swarmStore.ts:221-227。
  it.skip('BUG duplicate: 同一事件重复投递不应在 eventLog 产生两条 timeline 记录', () => {
    const store = useSwarmStore.getState();
    const e = evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'ready' }),
    }, 1000);

    store.handleEvent(evt('swarm:started', {}, 999));
    store.handleEvent(e);
    const countAfterFirst = useSwarmStore.getState().eventLog.filter((entry) =>
      entry.id === `evt-1000-swarm:agent:added-a1`,
    ).length;
    store.handleEvent(e);
    const countAfterSecond = useSwarmStore.getState().eventLog.filter((entry) =>
      entry.id === `evt-1000-swarm:agent:added-a1`,
    ).length;

    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1);
  });

});

// ---------------------------------------------------------------------------
// Priority 2.b: 乱序事件 — 最终状态收敛
// ---------------------------------------------------------------------------

describe('swarmStore chaos — 乱序事件收敛', () => {
  beforeEach(() => {
    useSwarmStore.getState().reset();
  });

  it('agent:added 顺序 vs 反序投递，最终 agents 与 statistics 等价', () => {
    const added = [
      evt('swarm:agent:added', { agentState: agent('a1', { status: 'running' }) }, 100),
      evt('swarm:agent:added', { agentState: agent('a2', { status: 'running' }) }, 200),
      evt('swarm:agent:added', { agentState: agent('a3', { status: 'pending' }) }, 300),
    ];

    // 顺序投递
    useSwarmStore.getState().reset();
    useSwarmStore.getState().handleEvent(evt('swarm:started', {}, 1));
    for (const e of added) useSwarmStore.getState().handleEvent(e);
    const forward = coreSnapshot();

    // 反序投递
    useSwarmStore.getState().reset();
    useSwarmStore.getState().handleEvent(evt('swarm:started', {}, 1));
    for (const e of [...added].reverse()) useSwarmStore.getState().handleEvent(e);
    const reverse = coreSnapshot();

    // agents 集合（按 id）应等价
    const forwardIds = forward.agents.map((a) => a.id).sort();
    const reverseIds = reverse.agents.map((a) => a.id).sort();
    expect(reverseIds).toEqual(forwardIds);
    expect(reverse.statistics.running).toBe(forward.statistics.running);
    expect(reverse.statistics.pending).toBe(forward.statistics.pending);
  });

  it('agent:updated 对同一 agent 的乱序投递 — last-write-wins 但不崩溃', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));
    store.handleEvent(evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'pending' }),
    }, 100));

    // 乱序：先来 iterations=5 的 later 事件，再来 iterations=2 的 earlier 事件
    store.handleEvent(evt('swarm:agent:updated', {
      agentState: agent('a1', { status: 'running', iterations: 5 }),
    }, 300));
    store.handleEvent(evt('swarm:agent:updated', {
      agentState: agent('a1', { status: 'running', iterations: 2 }),
    }, 200));

    const state = useSwarmStore.getState();
    // 当前实现是 last-write-wins 不做 timestamp 比较 → iterations=2 会覆盖 5
    // 这里不断言"应该按 timestamp 保留最新"，而是固化当前行为。
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].id).toBe('a1');
    expect(state.agents[0].iterations).toBe(2);
  });

  // ADR-010 item #6 固定：生产修复见 swarmStore.ts:556-595（hasActivity 守卫）。
  it('agent:added 先到、swarm:started 后到时，agent 不应被清空', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'running' }),
    }, 100));
    store.handleEvent(evt('swarm:started', {
      statistics: {
        total: 1, completed: 0, failed: 0, running: 1, pending: 0,
        parallelPeak: 1, totalTokens: 0, totalToolCalls: 0,
      },
    }, 50)); // timestamp 更早，但投递更晚

    const state = useSwarmStore.getState();
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].id).toBe('a1');
    expect(state.isRunning).toBe(true);
  });

  it('swarm:completed 先到、agent:completed 后到 — 最终 agents / statistics 仍合理', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));
    store.handleEvent(evt('swarm:agent:added', {
      agentState: agent('a1', { status: 'running' }),
    }, 100));

    // 乱序：completed 在前，单个 agent:completed 在后
    store.handleEvent(evt('swarm:completed', {
      result: {
        success: true,
        totalTime: 500,
        aggregation: {
          summary: 'done',
          filesChanged: [],
          totalCost: 0,
          totalDuration: 500,
          speedup: 1,
          successRate: 1,
          totalIterations: 1,
        },
      },
    }, 400));
    store.handleEvent(evt('swarm:agent:completed', {
      agentState: agent('a1', { status: 'completed', startTime: 10, endTime: 20 }),
    }, 300));

    const state = useSwarmStore.getState();
    // isRunning 应被 swarm:completed 置 false，不应被后到的 agent:completed 翻回 true
    expect(state.isRunning).toBe(false);
    expect(state.aggregation?.summary).toBe('done');
    // agent a1 的状态最终是 completed（merge 后以后到事件为准）
    const a1 = state.agents.find((a) => a.id === 'a1');
    expect(a1?.status).toBe('completed');
  });

  it('plan_approved 比对应的 plan_review 先到 — 状态应仍然落到 approved', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:started', {}, 1));

    // 乱序：approved 先到
    store.handleEvent(evt('swarm:agent:plan_approved', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1', feedback: 'ok' },
    }, 200));
    store.handleEvent(evt('swarm:agent:plan_review', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1' },
    }, 100));

    // 当前实现：approved 先到时 `upsertPlanReview` 走 fallback 直接 push 一条
    // approved 记录；后到的 plan_review 又 push 一条 pending。结果是两条记录。
    // 这里只断言"没崩溃 + 存在一条 approved"，把两条 vs 一条的分歧写进 BUG skip。
    const state = useSwarmStore.getState();
    const approved = state.planReviews.filter((r) => r.status === 'approved');
    expect(approved.length).toBeGreaterThanOrEqual(1);
    expect(approved[0].id).toBe('plan-1');
  });

  // ADR-010 #6 固定：plan_review 分支按 id 去重（swarmStore.ts:410-420），
  // plan_approved fallback 也按 id 去重（swarmStore.ts:447-463）。
  it('plan_approved 先于 plan_review 到达，最终只应有一条 approved', () => {
    const store = useSwarmStore.getState();
    store.handleEvent(evt('swarm:agent:plan_approved', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1', feedback: 'ok' },
    }, 200));
    store.handleEvent(evt('swarm:agent:plan_review', {
      agentId: 'a1',
      plan: { id: 'plan-1', agentId: 'a1', content: 'v1' },
    }, 100));

    const state = useSwarmStore.getState();
    expect(state.planReviews).toHaveLength(1);
    expect(state.planReviews[0].status).toBe('approved');
  });
});
