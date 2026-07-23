import { describe, expect, it } from 'vitest';
import { rebuildRunDetail } from '../../../src/host/services/core/swarmRollupProjection';
import type { SwarmLedgerEvent } from '../../../src/shared/contract/swarmLedger';

let autoId = 1;
function ev(over: Partial<SwarmLedgerEvent> & Pick<SwarmLedgerEvent, 'seq' | 'kind'>): SwarmLedgerEvent {
  return {
    id: autoId++, runId: 'run-1', sessionId: 's1', agentId: null, payload: {}, recordedAt: 100 + over.seq,
    ...over,
  };
}
const agentSnap = (seq: number, agentId: string, status: string, over: Record<string, unknown> = {}): SwarmLedgerEvent =>
  ev({ seq, kind: 'agent_snapshot', agentId, payload: { agentId, name: agentId, role: 'worker', status, startTime: 100, endTime: status === 'running' ? null : 200, durationMs: status === 'running' ? null : 100, tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [], ...over } });

describe('rebuildRunDetail（3b · 从 ledger 重建 rollup）', () => {
  it('从 run_started + agent_snapshot + run_closed 重建 run+agents 全字段', () => {
    const events: SwarmLedgerEvent[] = [
      ev({ seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 2, trigger: 'llm-spawn' } }),
      agentSnap(1, 'a1', 'completed', { tokensIn: 30, tokensOut: 15, toolCalls: 3, costUsd: 0.05 }),
      agentSnap(2, 'a2', 'completed', { tokensIn: 20, tokensOut: 10, toolCalls: 2, costUsd: 0.03 }),
      ev({ seq: 3, kind: 'run_closed', payload: { status: 'completed', endedAt: 300, completedCount: 2, failedCount: 0, parallelPeak: 2, totalTokensIn: 50, totalTokensOut: 25, totalToolCalls: 5, totalCostUsd: 0.08, errorSummary: null, aggregation: null, tags: [] } }),
    ];
    const detail = rebuildRunDetail(events)!;
    expect(detail.run.id).toBe('run-1');
    expect(detail.run.status).toBe('completed');
    expect(detail.run.startedAt).toBe(100);
    expect(detail.run.endedAt).toBe(300);
    // totals 从 agent 末值独立累加
    expect(detail.run.totalTokensIn).toBe(50);
    expect(detail.run.totalTokensOut).toBe(25);
    expect(detail.run.totalToolCalls).toBe(5);
    expect(detail.run.totalCostUsd).toBeCloseTo(0.08);
    expect(detail.run.completedCount).toBe(2);
    expect(detail.agents).toHaveLength(2);
  });

  it('同 agent 多条 snapshot → 末值覆盖', () => {
    const events: SwarmLedgerEvent[] = [
      ev({ seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' } }),
      agentSnap(1, 'a1', 'running', { tokensIn: 10, toolCalls: 1 }),
      agentSnap(2, 'a1', 'running', { tokensIn: 30, toolCalls: 3 }),
      agentSnap(3, 'a1', 'completed', { tokensIn: 50, toolCalls: 5 }),
    ];
    const detail = rebuildRunDetail(events)!;
    expect(detail.agents).toHaveLength(1);
    expect(detail.agents[0].status).toBe('completed');
    expect(detail.agents[0].tokensIn).toBe(50);   // 末值
    expect(detail.run.totalTokensIn).toBe(50);     // totals 用末值
    expect(detail.run.status).toBe('running');     // 无 run_closed → running
  });

  it('parallelPeak 按时刻 running-count 峰值重算', () => {
    const events: SwarmLedgerEvent[] = [
      ev({ seq: 0, kind: 'run_started', payload: { coordinator: 'parallel', startedAt: 0, totalAgents: 3, trigger: 'auto' } }),
      agentSnap(1, 'a1', 'running'),                       // running: a1 → peak 1
      agentSnap(2, 'a2', 'running'),                       // running: a1,a2 → peak 2
      agentSnap(3, 'a3', 'running'),                       // running: a1,a2,a3 → peak 3
      agentSnap(4, 'a1', 'completed'),                     // running: a2,a3 → 2
      agentSnap(5, 'a2', 'completed'),                     // running: a3 → 1
    ];
    const detail = rebuildRunDetail(events)!;
    expect(detail.run.parallelPeak).toBe(3);
  });

  it('无 run_started → 返回 null（事件不足以确定 run）', () => {
    expect(rebuildRunDetail([agentSnap(0, 'a1', 'running')])).toBeNull();
    expect(rebuildRunDetail([])).toBeNull();
  });

  it('坏 payload 的单条事件跳过，不毁整次重建', () => {
    const events: SwarmLedgerEvent[] = [
      ev({ seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' } }),
      ev({ seq: 1, kind: 'agent_snapshot', agentId: null, payload: null }), // 坏：无 agentId/payload
      agentSnap(2, 'a1', 'completed', { tokensIn: 7 }),
    ];
    const detail = rebuildRunDetail(events)!;
    expect(detail.agents).toHaveLength(1);
    expect(detail.run.totalTokensIn).toBe(7);
  });

  it('历史 agent_snapshot 缺少任务/产出字段仍可回放，并保留缺省值', () => {
    const events: SwarmLedgerEvent[] = [
      ev({ seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' } }),
      // 2026-07-23 前的真实历史形状：没有任何新字段。
      agentSnap(1, 'legacy-agent', 'completed'),
    ];
    const detail = rebuildRunDetail(events)!;
    expect(detail.agents[0]).toMatchObject({ agentId: 'legacy-agent', status: 'completed' });
    expect(detail.agents[0]?.dispatchedTask).toBeUndefined();
    expect(detail.agents[0]?.finalOutput).toBeUndefined();
    expect(detail.agents[0]?.dispatchedTaskTruncated).toBeUndefined();
    expect(detail.agents[0]?.finalOutputArchiveItemId).toBeUndefined();
  });

  it('回放新快照的任务、完整产出与归档引用', () => {
    const events: SwarmLedgerEvent[] = [
      ev({ seq: 0, kind: 'run_started', payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' } }),
      agentSnap(1, 'a1', 'completed', {
        dispatchedTask: '调查留存',
        finalOutput: '完整结论，不是 200 字预览',
        finalOutputTruncated: true,
        finalOutputArchiveItemId: 'lib_full_output',
      }),
    ];
    expect(rebuildRunDetail(events)!.agents[0]).toMatchObject({
      dispatchedTask: '调查留存',
      finalOutput: '完整结论，不是 200 字预览',
      finalOutputTruncated: true,
      finalOutputArchiveItemId: 'lib_full_output',
    });
  });
});
