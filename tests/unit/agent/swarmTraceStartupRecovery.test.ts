// ============================================================================
// SwarmTraceStartupRecovery Tests — 重启后 running swarm run 的启动收口
// （N-STALE-AGENT-CHIP-AFTER-QUIT A：成员条不再谎报「N 个代理工作中」）
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  applySwarmTraceStartupRecovery,
  type SwarmTraceStartupRecoveryDeps,
} from '../../../src/host/agent/swarmTraceStartupRecovery';
import type {
  AppendEventInput,
  CloseRunInput,
  SwarmRunDetail,
  SwarmRunListItem,
  UpsertAgentInput,
} from '../../../src/shared/contract/swarmTrace';
import type { SwarmLedgerAppendInput, SwarmLedgerEvent } from '../../../src/shared/contract/swarmLedger';

interface Harness {
  deps: SwarmTraceStartupRecoveryDeps;
  runs: SwarmRunListItem[];
  details: Map<string, SwarmRunDetail>;
  ledgerByRun: Map<string, SwarmLedgerEvent[]>;
  upserts: UpsertAgentInput[];
  closes: CloseRunInput[];
  ledgerAppends: SwarmLedgerAppendInput[];
  events: AppendEventInput[];
}

function makeHarness(overrides: Partial<SwarmTraceStartupRecoveryDeps> = {}): Harness {
  const runs: SwarmRunListItem[] = [];
  const details = new Map<string, SwarmRunDetail>();
  const ledgerByRun = new Map<string, SwarmLedgerEvent[]>();
  const upserts: UpsertAgentInput[] = [];
  const closes: CloseRunInput[] = [];
  const ledgerAppends: SwarmLedgerAppendInput[] = [];
  const events: AppendEventInput[] = [];

  const deps: SwarmTraceStartupRecoveryDeps = {
    now: 10_000,
    bootMs: 5_000,
    listRuns: () => runs,
    getRunDetail: (runId) => details.get(runId) ?? null,
    upsertAgent: (input) => upserts.push(input),
    closeRun: (input) => closes.push(input),
    appendLedger: (input) => ledgerAppends.push(input),
    ledgerEvents: (runId) => ledgerByRun.get(runId) ?? [],
    appendEvent: (input) => events.push(input),
    ...overrides,
  };
  return { deps, runs, details, ledgerByRun, upserts, closes, ledgerAppends, events };
}

function runItem(id: string, status: SwarmRunListItem['status'], startedAt: number): SwarmRunListItem {
  return {
    id,
    sessionId: 'session-1',
    status,
    coordinator: 'hybrid',
    startedAt,
    endedAt: null,
    durationMs: null,
    totalAgents: 1,
    completedCount: 0,
    failedCount: 0,
    totalCostUsd: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    trigger: 'llm-spawn',
  };
}

function detailOf(run: SwarmRunListItem, agents: SwarmRunDetail['agents']): SwarmRunDetail {
  return {
    run: {
      id: run.id,
      sessionId: run.sessionId,
      coordinator: run.coordinator,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: null,
      totalAgents: agents.length,
      completedCount: 0,
      failedCount: 0,
      parallelPeak: 1,
      totalTokensIn: 10,
      totalTokensOut: 20,
      totalToolCalls: 2,
      totalCostUsd: 0.01,
      trigger: run.trigger,
      errorSummary: null,
      aggregation: null,
      tags: [],
    },
    agents,
    events: [
      { id: 1, runId: run.id, seq: 0, timestamp: run.startedAt, eventType: 'swarm:started', agentId: null, level: 'info', title: 'started', summary: '', payload: {} },
    ],
  };
}

function agentOf(runId: string, agentId: string, status: SwarmRunDetail['agents'][number]['status']): SwarmRunDetail['agents'][number] {
  return {
    runId,
    agentId,
    name: 'Explorer',
    role: 'explore',
    status,
    startTime: 1_000,
    endTime: null,
    durationMs: null,
    tokensIn: 5,
    tokensOut: 6,
    toolCalls: 1,
    costUsd: 0.01,
    error: null,
    failureCategory: null,
    filesChanged: [],
  };
}

describe('applySwarmTraceStartupRecovery', () => {
  it('closes a pre-boot running run as cancelled and settles its open agents', () => {
    const h = makeHarness();
    const run = runItem('run-stale', 'running', 1_000);
    h.runs.push(run);
    h.details.set(run.id, detailOf(run, [
      agentOf(run.id, 'agent-ghost', 'running'),
      agentOf(run.id, 'agent-done', 'completed'),
    ]));
    h.ledgerByRun.set(run.id, [
      { id: 1, runId: run.id, sessionId: 'session-1', seq: 0, kind: 'run_started', agentId: null, payload: null, recordedAt: 1_000 },
      { id: 2, runId: run.id, sessionId: 'session-1', seq: 1, kind: 'agent_snapshot', agentId: 'agent-ghost', payload: null, recordedAt: 1_100 },
    ]);

    const result = applySwarmTraceStartupRecovery(h.deps);

    expect(result).toEqual({ runsClosed: 1, agentsCancelled: 1 });
    // 未完成成员收成 cancelled，终态成员不动。
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({
      runId: 'run-stale',
      agentId: 'agent-ghost',
      status: 'cancelled',
      endTime: 10_000,
      error: 'interrupted by app restart',
      failureCategory: 'interrupted_by_restart',
    });
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]).toMatchObject({
      id: 'run-stale',
      status: 'cancelled',
      endedAt: 10_000,
      completedCount: 1,
      failedCount: 0,
    });
    // 账本续接存量 seq（0,1 之后从 2 起），run_closed 收尾。
    expect(h.ledgerAppends.map((entry) => [entry.seq, entry.kind])).toEqual([
      [2, 'agent_snapshot'],
      [3, 'run_closed'],
    ]);
    expect(h.ledgerAppends[1].payload).toMatchObject({ status: 'cancelled' });
    // timeline 追加一条收口说明（seq 续接存量 0 之后）。
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ runId: 'run-stale', seq: 1, eventType: 'swarm:cancelled' });
  });

  it('leaves a run started after this process booted alone (recovered/resumed live run)', () => {
    const h = makeHarness();
    const run = runItem('run-live', 'running', 6_000); // bootMs = 5_000
    h.runs.push(run);
    h.details.set(run.id, detailOf(run, [agentOf(run.id, 'agent-live', 'running')]));

    const result = applySwarmTraceStartupRecovery(h.deps);

    expect(result).toEqual({ runsClosed: 0, agentsCancelled: 0 });
    expect(h.upserts).toHaveLength(0);
    expect(h.closes).toHaveLength(0);
    expect(h.ledgerAppends).toHaveLength(0);
  });

  it('leaves terminal runs and runs without stored detail untouched', () => {
    const h = makeHarness();
    const terminal = runItem('run-done', 'completed', 1_000);
    const missingDetail = runItem('run-nodetail', 'running', 1_000);
    h.runs.push(terminal, missingDetail);
    h.details.set(terminal.id, detailOf(terminal, [agentOf(terminal.id, 'agent-1', 'completed')]));

    const result = applySwarmTraceStartupRecovery(h.deps);

    expect(result).toEqual({ runsClosed: 0, agentsCancelled: 0 });
    expect(h.closes).toHaveLength(0);
  });
});
