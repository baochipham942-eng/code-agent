import { describe, expect, it } from 'vitest';
import {
  buildSessionLedger,
  type LedgerSources,
} from '../../../src/main/services/core/sessionLedgerProjection';
import type { Message } from '../../../src/shared/contract/message';
import type { SwarmRunListItem, SwarmRunEventRecord } from '../../../src/shared/contract/swarmTrace';
import type { PermissionDecisionRecord } from '../../../src/main/services/core/repositories/PermissionDecisionRepository';
import type { ToolExecutionEventRecord } from '../../../src/main/services/core/repositories/ToolExecutionEventRepository';

const SID = 'sess-1';
const GEN_AT = 9_999;

function msg(over: Partial<Message>): Message {
  return { id: 'm', role: 'user', content: 'hi', timestamp: 0, ...over } as Message;
}
function swarmRun(over: Partial<SwarmRunListItem>): SwarmRunListItem {
  return {
    id: 'run-1', sessionId: SID, status: 'completed', coordinator: 'orchestrator',
    startedAt: 0, endedAt: null, durationMs: null, totalAgents: 2,
    completedCount: 2, failedCount: 0, totalCostUsd: 0, totalTokensIn: 0,
    totalTokensOut: 0, trigger: 'manual',
    ...over,
  } as SwarmRunListItem;
}
function decision(over: Partial<PermissionDecisionRecord>): PermissionDecisionRecord {
  return {
    id: 1, sessionId: SID, toolName: 'Bash', summary: null, finalOutcome: 'allow',
    historyOutcome: 'auto-approve', reason: 'policy', durationMs: 5, recordedAt: 0, trace: null,
    ...over,
  };
}
function execution(over: Partial<ToolExecutionEventRecord>): ToolExecutionEventRecord {
  return {
    id: 1, executionId: 'exec-1', sessionId: SID, toolName: 'Bash', summary: null,
    params: null, phase: 'begin', status: null, error: null, recordedAt: 0,
    ...over,
  };
}

function emptySources(): LedgerSources {
  return {
    messages: [], taskEvents: [], swarmRuns: [], swarmEvents: [],
    decisions: [], executions: [],
    cost: { estimatedCost: 0, tokensIn: 0, tokensOut: 0 },
  };
}

describe('buildSessionLedger', () => {
  it('合并 6 路输入并按 at 升序排列', () => {
    const sources: LedgerSources = {
      messages: [msg({ id: 'm1', role: 'user', content: '帮我跑测试', timestamp: 100 })],
      taskEvents: [{ taskId: '1', at: 200, kind: 'created', summary: '跑测试' }],
      swarmRuns: [swarmRun({ id: 'run-1', startedAt: 300, endedAt: 600, totalCostUsd: 0.0123, status: 'completed' })],
      swarmEvents: [{ id: 1, runId: 'run-1', seq: 1, timestamp: 400, eventType: 'agent_spawn', agentId: 'a1', level: 'info', title: 'spawn a1', summary: '', payload: null } as SwarmRunEventRecord],
      decisions: [decision({ id: 7, recordedAt: 450, finalOutcome: 'allow', toolName: 'Bash', reason: 'auto' })],
      executions: [
        execution({ executionId: 'e1', recordedAt: 500, phase: 'begin', toolName: 'Bash' }),
        execution({ executionId: 'e1', recordedAt: 550, phase: 'complete', status: 'success', toolName: 'Bash' }),
      ],
      cost: { estimatedCost: 0.5, tokensIn: 1000, tokensOut: 200 },
    };

    const ledger = buildSessionLedger(SID, sources, GEN_AT);

    expect(ledger.sessionId).toBe(SID);
    expect(ledger.generatedAt).toBe(GEN_AT);
    // at 升序
    const ats = ledger.entries.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    // 各 lane 都在
    const lanes = new Set(ledger.entries.map((e) => e.lane));
    expect(lanes).toEqual(new Set(['message', 'task', 'swarm', 'decision', 'execution']));
  });

  it('归一化各 lane 的 kind/summary/refId 正确', () => {
    const sources = emptySources();
    sources.messages = [msg({ id: 'm1', role: 'assistant', content: '好的', timestamp: 1 })];
    sources.taskEvents = [{ taskId: '1.1', at: 2, kind: 'done', summary: '完成', actor: 'agent-x' }];
    sources.swarmRuns = [swarmRun({ id: 'run-9', startedAt: 3, endedAt: 4, status: 'failed', completedCount: 1, failedCount: 1, totalCostUsd: 0.01 })];
    sources.decisions = [decision({ id: 42, recordedAt: 5, finalOutcome: 'deny', toolName: 'Write', reason: 'blocked' })];
    sources.executions = [execution({ executionId: 'e9', recordedAt: 6, phase: 'complete', status: 'error', toolName: 'Read', error: 'ENOENT' })];

    const e = buildSessionLedger(SID, sources, GEN_AT).entries;
    const byLane = (l: string) => e.filter((x) => x.lane === l);

    expect(byLane('message')[0]).toMatchObject({ kind: 'assistant', summary: '好的', refId: 'm1' });
    expect(byLane('task')[0]).toMatchObject({ kind: 'done', summary: '1.1: 完成', refId: '1.1', detail: { actor: 'agent-x' } });
    // swarm run → 起 + 止 两条
    const sw = byLane('swarm');
    expect(sw).toHaveLength(2);
    expect(sw[0]).toMatchObject({ kind: 'run_started', refId: 'run-9' });
    expect(sw[1]).toMatchObject({ kind: 'run_failed', refId: 'run-9' });
    expect(byLane('decision')[0]).toMatchObject({ kind: 'deny', summary: 'Write: blocked', refId: '42' });
    expect(byLane('execution')[0]).toMatchObject({ kind: 'complete:error', refId: 'e9', detail: { error: 'ENOENT' } });
  });

  it('cost 汇总透传 + laneCounts 计数正确', () => {
    const sources = emptySources();
    sources.messages = [msg({ timestamp: 1 }), msg({ timestamp: 2 })];
    sources.taskEvents = [{ taskId: '1', at: 3, kind: 'created' }];
    sources.swarmRuns = [swarmRun({ startedAt: 4, endedAt: 5 })]; // → 2 条 swarm
    sources.cost = { estimatedCost: 1.25, tokensIn: 3000, tokensOut: 800 };

    const ledger = buildSessionLedger(SID, sources, GEN_AT);
    expect(ledger.cost).toEqual({ estimatedCost: 1.25, tokensIn: 3000, tokensOut: 800 });
    expect(ledger.laneCounts.message).toBe(2);
    expect(ledger.laneCounts.task).toBe(1);
    expect(ledger.laneCounts.swarm).toBe(2);
    expect(ledger.laneCounts.decision).toBe(0);
    expect(ledger.laneCounts.execution).toBe(0);
  });

  it('同一时刻按泳道输入序稳定 tie-break（message 在 task 之前处理）', () => {
    const sources = emptySources();
    sources.messages = [msg({ id: 'mA', timestamp: 1000 })];
    sources.taskEvents = [{ taskId: 'tA', at: 1000, kind: 'created' }];
    sources.decisions = [decision({ id: 1, recordedAt: 1000 })];
    const e = buildSessionLedger(SID, sources, GEN_AT).entries;
    // 三条都在 at=1000，应按处理序 message → task → decision
    expect(e.map((x) => x.lane)).toEqual(['message', 'task', 'decision']);
  });

  it('单 lane 抛错只让该 lane 为空，其余 lane 完整（fail-safe 隔离）', () => {
    const sources = emptySources();
    sources.taskEvents = [{ taskId: '1', at: 5, kind: 'created' }];
    sources.decisions = [decision({ id: 1, recordedAt: 6 })];
    // messages getter 访问即抛错（模拟 fail-safe facade 异常）
    Object.defineProperty(sources, 'messages', {
      get() { throw new Error('lane boom'); },
      configurable: true,
    });

    const ledger = buildSessionLedger(SID, sources, GEN_AT);
    expect(ledger.laneCounts.message).toBe(0); // 抛错 lane 计 0
    expect(ledger.laneCounts.task).toBe(1);     // 其余 lane 完整
    expect(ledger.laneCounts.decision).toBe(1);
    expect(ledger.entries).toHaveLength(2);
  });

  it('空输入产出空账（不抛）', () => {
    const ledger = buildSessionLedger(SID, emptySources(), GEN_AT);
    expect(ledger.entries).toEqual([]);
    expect(ledger.cost.estimatedCost).toBe(0);
  });
});
