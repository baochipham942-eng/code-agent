// ============================================================================
// agentRowStall - 代理行「暂无进展」判定（N-FIX-WF-STALL-SPAWN-AGENT）
// 纯函数假时钟：显式传 now，钉死 阈值边界 / 审批豁免 / fail-closed 三类不变量。
// 阈值单一真源 WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS（2 分钟），此处不写魔法数。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';
import { isAgentRowQuiet } from '../../../src/renderer/utils/agentRowStall';
import type { AgentRow, MemberRowSource } from '../../../src/renderer/utils/agentRows';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';

const T0 = 1_700_000_000_000;

function memberRow(overrides: Partial<MemberRowSource> = {}): MemberRowSource {
  return {
    key: 'explore-1',
    roleId: 'explore',
    name: '探查员',
    status: 'running',
    isLead: false,
    lastActivityAt: T0,
    ...overrides,
  };
}

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    key: 'explore-1',
    kind: 'expert',
    name: '探查员',
    isLead: false,
    status: 'working',
    stoppable: true,
    member: memberRow(),
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

  it('非 working 状态不报：waiting / done / failed / cancelled / standby', () => {
    expect(isAgentRowQuiet(row({ status: 'waiting' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'done' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'failed' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'cancelled' }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ status: 'standby' }), T0 + 121_000)).toBe(false);
  });

  it('没有锚点 fail-closed 不报：后台任务行、无锚点的节点行、锚点缺失的成员', () => {
    expect(isAgentRowQuiet(row({ member: undefined }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(nodeRow(), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(row({ kind: 'task', member: undefined }), T0 + 121_000)).toBe(false);
    expect(isAgentRowQuiet(
      row({ member: memberRow({ lastActivityAt: undefined }) }),
      T0 + 121_000,
    )).toBe(false);
  });

  it('锚点前进即清：lastActivityAt 刷到近期就不再报（新进展清提示）', () => {
    expect(isAgentRowQuiet(
      row({ member: memberRow({ lastActivityAt: T0 + 120_000 }) }),
      T0 + 121_000,
    )).toBe(false);
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

    it('并入专家行的节点仍用 member 锚点，不被节点锚点覆盖', () => {
      const merged = row({
        node: nodeRow({ updatedAt: T0 - 500_000 }).node,
        member: memberRow({ lastActivityAt: T0 + 100_000 }),
      });
      expect(isAgentRowQuiet(merged, T0 + 121_000)).toBe(false);
    });
  });
});
