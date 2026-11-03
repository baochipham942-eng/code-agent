// ============================================================================
// agentRowStall - 代理行「暂无进展」判定（N-FIX-WF-STALL-SPAWN-AGENT）
// 纯函数假时钟：显式传 now，钉死 阈值边界 / 审批豁免 / fail-closed 三类不变量。
// 阈值单一真源 WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS（2 分钟），此处不写魔法数。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';
import { isAgentRowQuiet } from '../../../src/renderer/utils/agentRowStall';
import type { AgentRow, MemberRowSource } from '../../../src/renderer/utils/agentRows';

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

  it('没有锚点 fail-closed 不报：agentTree/后台任务行（无 member）、锚点缺失的成员', () => {
    expect(isAgentRowQuiet(row({ member: undefined }), T0 + 121_000)).toBe(false);
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
});
