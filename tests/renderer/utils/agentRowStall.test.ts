// ============================================================================
// agentRowStall - 代理行「暂无进展」判定（N-FIX-WF-STALL-SPAWN-AGENT）
// 纯函数假时钟：显式传 now，钉死 阈值边界 / 审批豁免 / fail-closed 三类不变量。
// 阈值单一真源 WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS（2 分钟），此处不写魔法数。
// r4：成员夹具按生产形状装配——持久化记录经 swarmRunAgentRecordToState（不带
// contextSnapshot）+ 同 id 流状态（swarmStore）经 memberProgressAnchor 出活锚点。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';
import { isAgentRowQuiet } from '../../../src/renderer/utils/agentRowStall';
import type { AgentRow, MemberRowSource } from '../../../src/renderer/utils/agentRows';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import type { SwarmAgentContextSnapshot, SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord } from '../../../src/shared/contract/swarmTrace';
import { memberProgressAnchor } from '../../../src/renderer/utils/memberProgressAnchor';
import { swarmRunAgentRecordToState } from '../../../src/renderer/components/features/expert/SessionMemberBar';

const T0 = 1_700_000_000_000;

const persistedRecord = (overrides: Partial<SwarmRunAgentRecord> = {}): SwarmRunAgentRecord => ({
  runId: 'run-1', agentId: 'explore-1', name: '探查员', role: 'explore', status: 'running',
  startTime: T0, endTime: null, durationMs: null, tokensIn: 0, tokensOut: 0, toolCalls: 0,
  costUsd: 0, error: null, failureCategory: null, filesChanged: [], ...overrides,
});

/** swarmStore 流状态里的活快照：lastUpdated 随真实进展前进。 */
const liveSnapshot = (lastUpdated: number): SwarmAgentContextSnapshot => ({
  currentTokens: 100, maxTokens: 1_000, usagePercent: 10, messageCount: 2, warningLevel: 'normal',
  lastUpdated, tools: [], attachments: [], previews: [], truncatedMessages: 0,
});

const liveAgentState = (overrides: Partial<SwarmAgentState> = {}): SwarmAgentState => ({
  id: 'explore-1', name: '探查员', role: 'explore', status: 'running', iterations: 1,
  ...overrides,
});

/** 生产装配：持久化记录转 state（无 contextSnapshot）→ memberProgressAnchor 配同 id 流状态出活锚点。 */
function memberRow(input: { record?: Partial<SwarmRunAgentRecord>; live?: SwarmAgentState | null } = {}): MemberRowSource {
  const agent = swarmRunAgentRecordToState(persistedRecord(input.record));
  const lastActivityAt = memberProgressAnchor(agent, input.live ?? undefined);
  return { key: 'explore-1', roleId: 'explore', name: '探查员', status: 'running', isLead: false, lastActivityAt };
}

/** 缺省成员行：startTime=T0、流状态活锚点=T0（生产上「刚起步就静默」的形状）。 */
function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    key: 'explore-1',
    kind: 'expert',
    name: '探查员',
    isLead: false,
    status: 'working',
    stoppable: true,
    member: memberRow({ live: liveAgentState({ contextSnapshot: liveSnapshot(T0) }) }),
    ...overrides,
  };
}

function nodeRow(node: Partial<AgentTreeNode> = {}, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    key: 'agent-9',
    kind: 'agent',
    name: 'explore',
    isLead: false,
    status: 'working',
    stoppable: true,
    node: {
      id: 'agent-9', role: 'explore', status: 'running', statusLabel: '正在处理',
      children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [],
      sources: ['spawnGuard'], ...node,
    },
    ...overrides,
  };
}

describe('isAgentRowQuiet（N-FIX-WF-STALL-SPAWN-AGENT）', () => {
  it('working 行空转越过软阈值才报：119s 不报 / 121s 报', () => {
    expect(isAgentRowQuiet(row(), T0 + 119_000)).toBe(false);
    expect(isAgentRowQuiet(row(), T0 + 121_000)).toBe(true);
  });

  it('阈值取单一真源 N_SOFT_MS：正好压线不算（严格大于才报）', () => {
    expect(WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS).toBe(120_000);
    expect(isAgentRowQuiet(row(), T0 + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS)).toBe(false);
  });

  it('等审批不算卡住：用户在等，不是代理在等', () => {
    expect(isAgentRowQuiet(row({ hold: 'approval' }), T0 + 121_000)).toBe(false);
  });

  // N-WF-STALL-SPAWN-AGENT-APPROVAL-VERIFY：审批期间锚点不动，放行后必须重开一个完整窗口。
  it('审批 hold 整段等待（5 分钟）都不报；放行瞬间不闪，放行后满 120s 才报', () => {
    const held = row({ hold: 'approval' });
    for (let t = 0; t <= 300_000; t += 5_000) {
      expect(isAgentRowQuiet(held, T0 + t)).toBe(false);
    }
    const releasedAt = T0 + 300_000;
    const released = row();
    // 放行 tick：锚点还是 5 分钟前的 T0，但有效锚点应取 max(锚点, 放行时刻)
    expect(isAgentRowQuiet(released, releasedAt, releasedAt)).toBe(false);
    expect(isAgentRowQuiet(released, releasedAt + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS, releasedAt)).toBe(false);
    expect(isAgentRowQuiet(released, releasedAt + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 1, releasedAt)).toBe(true);
  });

  it('放行后真实进展比放行时刻还新：以进展锚点为准', () => {
    const fresh = row({ member: memberRow({ live: liveAgentState({ contextSnapshot: liveSnapshot(T0 + 400_000) }) }) });
    expect(isAgentRowQuiet(fresh, T0 + 400_000 + 121_000, T0 + 300_000)).toBe(true);
    expect(isAgentRowQuiet(fresh, T0 + 400_000 + 119_000, T0 + 300_000)).toBe(false);
  });

  it('非 working 状态不报：waiting / done / failed / cancelled / standby', () => {
    expect(isAgentRowQuiet(row({ status: 'waiting' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'done' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'failed' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'cancelled' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'standby' }), T0 + 121_000)).toBe(false);
  });

  it('没有活锚点 fail-closed 不报：后台任务行、无锚点的节点行、只有账本记录的成员（不回落 startTime）', () => {
    expect(isAgentRowQuiet(row({ member: undefined }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(nodeRow(), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ kind: 'task', member: undefined }), T0 + 121_000)).toBe(false);
    // 生产形状：持久化记录 startTime 很老，但没有流状态 → 无活锚点 → 不报
    expect(isAgentRowQuiet(
      row({ member: memberRow({ record: { startTime: T0 - 500_000 }, live: null }) }),
      T0 + 121_000,
    )).toBe(false);
  });

  it('r4 回归：跑了 >2 分钟但活锚点 10s 前（正在干活）不报', () => {
    const member = memberRow({
      record: { startTime: T0 - 500_000 },
      live: liveAgentState({ contextSnapshot: liveSnapshot(T0 + 110_000) }),
    });
    expect(isAgentRowQuiet(row({ member }), T0 + 121_000)).toBe(false);
  });

  it('锚点前进即清：流状态 lastUpdated 刷到近期就不再报（新进展清提示）', () => {
    expect(isAgentRowQuiet(
      row({ member: memberRow({ live: liveAgentState({ contextSnapshot: liveSnapshot(T0 + 120_000) }) }) }),
      T0 + 121_000,
    )).toBe(false);
  });

  it('memberProgressAnchor 装配口径：账本 state 无快照 → undefined；两路快照取最新；自带快照也算', () => {
    expect(memberProgressAnchor(swarmRunAgentRecordToState(persistedRecord()))).toBeUndefined();
    expect(memberProgressAnchor(
      swarmRunAgentRecordToState(persistedRecord()),
      liveAgentState({ contextSnapshot: liveSnapshot(T0 + 30_000) }),
    )).toBe(T0 + 30_000);
    expect(memberProgressAnchor(
      swarmRunAgentRecordToState(persistedRecord({ startTime: T0 })),
      liveAgentState({ contextSnapshot: liveSnapshot(T0 + 30_000) }),
    )).toBe(T0 + 30_000); // startTime 永远不参与
    expect(memberProgressAnchor(
      { ...liveAgentState(), contextSnapshot: liveSnapshot(T0 + 10_000) },
      liveAgentState({ contextSnapshot: liveSnapshot(T0 + 50_000) }),
    )).toBe(T0 + 50_000);
    // 同 id 匹配是调用方（fromAgents 的 liveAgentById.get）的契约，helper 只管两路快照取最新
  });

  describe('agentTree 节点行（前台 spawn_agent，无 member）', () => {
    it('updatedAt 锚点：119s 不报 / 121s 报', () => {
      const r = nodeRow({ updatedAt: T0 });
      expect(isAgentRowQuiet(r, T0 + 119_000)).toBe(false);
      expect(isAgentRowQuiet(r, T0 + 121_000)).toBe(true);
    });

    it('锚点优先级 lastToolStep.at > updatedAt > createdAt', () => {
      expect(isAgentRowQuiet(nodeRow({ createdAt: T0 }), T0 + 121_000)).toBe(true);
      expect(isAgentRowQuiet(nodeRow({ createdAt: T0, updatedAt: T0 + 100_000 }), T0 + 121_000)).toBe(false);
      expect(isAgentRowQuiet(
        nodeRow({ createdAt: T0, updatedAt: T0, lastToolStep: { tool: 'Read', at: T0 + 100_000 } }),
        T0 + 121_000,
      )).toBe(false);
    });

    it('锚点前进即清', () => {
      expect(isAgentRowQuiet(nodeRow({ updatedAt: T0 }), T0 + 121_000)).toBe(true);
      expect(isAgentRowQuiet(nodeRow({ updatedAt: T0 + 60_000 }), T0 + 121_000)).toBe(false);
    });

    it('等审批不报；非 working 不报', () => {
      expect(isAgentRowQuiet(nodeRow({ updatedAt: T0 }, { hold: 'approval' }), T0 + 121_000)).toBe(false);
      expect(isAgentRowQuiet(nodeRow({ updatedAt: T0 }, { status: 'done' }), T0 + 121_000)).toBe(false);
    });
  });

  describe('并入专家行的节点（member + node 同行，r4）', () => {
    it('两路活锚点取最新：流状态新鲜 + 节点工具步老 → 不报', () => {
      const merged = row({
        node: nodeRow({ updatedAt: T0 - 500_000, lastToolStep: { tool: 'Read', at: T0 - 500_000 } }).node,
        member: memberRow({ live: liveAgentState({ contextSnapshot: liveSnapshot(T0 + 100_000) }) }),
      });
      expect(isAgentRowQuiet(merged, T0 + 121_000)).toBe(false);
    });

    it('节点 lastToolStep.at 必须算进展：无流状态时它是唯一锚点，老则报、新则清', () => {
      const nodeStale = nodeRow({ lastToolStep: { tool: 'Read', at: T0 } }).node;
      expect(isAgentRowQuiet(row({ node: nodeStale, member: memberRow({ live: null }) }), T0 + 121_000)).toBe(true);
      const nodeFresh = nodeRow({ lastToolStep: { tool: 'Read', at: T0 + 110_000 } }).node;
      expect(isAgentRowQuiet(row({ node: nodeFresh, member: memberRow({ live: null }) }), T0 + 121_000)).toBe(false);
    });

    it('成员行不用 node.updatedAt 当锚点（心跳风险）：updated 新也不能压住老的工具步', () => {
      const merged = row({
        node: nodeRow({ updatedAt: T0 + 110_000, lastToolStep: { tool: 'Read', at: T0 } }).node,
        member: memberRow({ live: null }),
      });
      expect(isAgentRowQuiet(merged, T0 + 121_000)).toBe(true);
    });
  });
});
