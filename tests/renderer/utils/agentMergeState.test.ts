// ============================================================================
// deriveAgentMergeState 单测（N-L6-AGENTVIEW S5）：「合没合」三态判定
// ============================================================================
import { describe, expect, it } from 'vitest';
import { deriveAgentMergeState } from '../../../src/renderer/utils/agentMergeState';
import type { AgentRowStatus } from '../../../src/renderer/utils/agentRows';

const rows = (...statuses: AgentRowStatus[]) => statuses.map((status) => ({ status }));
const conflict = { path: 'src/a.ts', ownerAgentId: 'a', requesterAgentId: 'b' };

describe('deriveAgentMergeState', () => {
  it('有所有权冲突一律报 conflict（优先级最高）', () => {
    expect(deriveAgentMergeState(rows('done', 'done'), [conflict])).toBe('conflict');
    // 即便同时有 waiting 行，冲突也先说
    expect(deriveAgentMergeState(rows('waiting', 'working'), [conflict])).toBe('conflict');
  });

  it('有 waiting 行报 waiting', () => {
    expect(deriveAgentMergeState(rows('working', 'waiting'), [])).toBe('waiting');
  });

  it('≥2 个非 standby 行且全部 done 报 merged', () => {
    expect(deriveAgentMergeState(rows('done', 'done'), [])).toBe('merged');
    expect(deriveAgentMergeState(rows('done', 'done', 'done'), [])).toBe('merged');
  });

  it('standby 行不参与「合没合」', () => {
    // standby 不算分子：两个 done + 一个 standby 仍然 merged
    expect(deriveAgentMergeState(rows('done', 'done', 'standby'), [])).toBe('merged');
    // 只剩 standby 不是 merged
    expect(deriveAgentMergeState(rows('standby', 'standby'), [])).toBeNull();
    // standby 不挡 waiting
    expect(deriveAgentMergeState(rows('standby', 'waiting'), [])).toBe('waiting');
  });

  it('其余情况不显示（null）', () => {
    expect(deriveAgentMergeState(rows('done'), [])).toBeNull(); // 单代理谈不上合
    expect(deriveAgentMergeState(rows('working', 'done'), [])).toBeNull(); // 还在干
    expect(deriveAgentMergeState(rows('done', 'failed'), [])).toBeNull(); // 有失败不算合
    expect(deriveAgentMergeState([], [])).toBeNull();
  });
});
