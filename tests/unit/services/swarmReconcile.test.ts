import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import { reconcileRun } from '../../../src/host/services/core/swarmReconcile';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { SwarmTraceRepository } from '../../../src/host/services/core/repositories/SwarmTraceRepository';
import { SwarmLedgerRepository } from '../../../src/host/services/core/repositories/SwarmLedgerRepository';
import { SwarmTraceWriter } from '../../../src/host/agent/swarmTraceWriter';
import { SwarmEventEmitter } from '../../../src/host/agent/swarmEventPublisher';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';
import type { SwarmRunDetail } from '../../../src/shared/contract/swarmTrace';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function detail(over: Partial<SwarmRunDetail['run']> = {}, agents: SwarmRunDetail['agents'] = []): SwarmRunDetail {
  return {
    run: {
      id: 'run-1', sessionId: 's1', coordinator: 'hybrid', status: 'completed', startedAt: 100, endedAt: 300,
      totalAgents: 1, completedCount: 1, failedCount: 0, parallelPeak: 1,
      totalTokensIn: 30, totalTokensOut: 15, totalToolCalls: 3, totalCostUsd: 0.05,
      trigger: 'llm-spawn', errorSummary: null, aggregation: null, tags: [], ...over,
    },
    agents,
    events: [],
  };
}

describe('reconcileRun（3b 影子对账 · 纯函数）', () => {
  it('两边一致 → match=true, drift 空', () => {
    const r = reconcileRun(detail(), detail(), 'run-1');
    expect(r.match).toBe(true);
    expect(r.drift).toEqual([]);
  });

  it('totals 不一致 → drift 精确定位字段', () => {
    const r = reconcileRun(detail({ totalTokensIn: 30 }), detail({ totalTokensIn: 99 }), 'run-1');
    expect(r.match).toBe(false);
    expect(r.drift).toEqual([{ scope: 'run', field: 'totalTokensIn', rebuilt: 30, stored: 99, tolerated: false }]);
  });

  it('parallelPeak 小偏差被容忍（不计 match 失败）', () => {
    const r = reconcileRun(detail({ parallelPeak: 2 }), detail({ parallelPeak: 3 }), 'run-1', { parallelPeakTolerance: 1 });
    expect(r.match).toBe(true);
    expect(r.drift[0]).toMatchObject({ field: 'parallelPeak', tolerated: true });
  });

  it('agent 级字段不一致 → drift 带 agent scope', () => {
    const a = (over = {}) => ({ runId: 'run-1', agentId: 'a1', name: 'a1', role: 'w', status: 'completed' as const, startTime: 1, endTime: 2, durationMs: 1, tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [], ...over });
    const r = reconcileRun(detail({}, [a({ toolCalls: 1 })]), detail({}, [a({ toolCalls: 9 })]), 'run-1');
    expect(r.match).toBe(false);
    expect(r.drift).toContainEqual({ scope: 'agent:a1', field: 'toolCalls', rebuilt: 1, stored: 9, tolerated: false });
  });

  it('缺一边 → match=false + note', () => {
    expect(reconcileRun(null, detail(), 'run-1').note).toBe('ledger-missing');
    expect(reconcileRun(detail(), null, 'run-1').note).toBe('rollup-missing');
  });
});

describe('DatabaseService.reconcileSwarmRun（3b 招牌：重建==现存 真实管线）', () => {
  let db: BetterSqlite3.Database;

  function wire(): DatabaseService {
    const svc = new DatabaseService();
    Object.assign(svc as unknown as Record<string, unknown>, {
      db,
      swarmTraceRepo: new SwarmTraceRepository(db),
      swarmLedgerRepo: new SwarmLedgerRepository(db),
    });
    return svc;
  }

  afterEach(() => {
    shutdownEventBus();
    vi.restoreAllMocks();
  });

  it('writer 同时写 rollup + ledger → 对账全字段一致（match=true）', async () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    const repo = new SwarmTraceRepository(db);
    const ledger = new SwarmLedgerRepository(db);
    const writer = new SwarmTraceWriter(repo, {
      getSessionId: () => 's1', defaultTrigger: 'llm-spawn', defaultCoordinator: 'hybrid',
      appendLedger: (input) => ledger.append(input),
    });
    writer.install();
    const em = new SwarmEventEmitter();
    em.started(1);
    const runId = em.getCurrentRunId()!;
    em.agentAdded({ id: 'a1', name: 'Coder', role: 'coder' });
    em.agentUpdated('a1', { status: 'running', startTime: 100, iterations: 1, tokenUsage: { input: 30, output: 15 }, toolCalls: 3 });
    em.agentCompleted('a1', 'done');
    em.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 500 });
    await writer.drain();
    await writer.dispose();

    const result = wire().reconcileSwarmRun(runId);
    expect(result.match).toBe(true);
    expect(result.drift.filter((d) => !d.tolerated)).toEqual([]);
    db.close();
  });

  it('rollup 表被人为改坏 → 对账 drift 抓出（真理源以 ledger 为准的依据）', async () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    const repo = new SwarmTraceRepository(db);
    const ledger = new SwarmLedgerRepository(db);
    const writer = new SwarmTraceWriter(repo, {
      getSessionId: () => 's1', appendLedger: (input) => ledger.append(input),
    });
    writer.install();
    const em = new SwarmEventEmitter();
    em.started(1);
    const runId = em.getCurrentRunId()!;
    em.agentAdded({ id: 'a1', name: 'Coder', role: 'coder' });
    em.agentUpdated('a1', { status: 'running', startTime: 100, iterations: 1, tokenUsage: { input: 30, output: 15 }, toolCalls: 3 });
    em.agentCompleted('a1', 'done');
    em.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 500 });
    await writer.drain();
    await writer.dispose();

    // 篡改 rollup 表（模拟覆盖写损坏），ledger 不动
    db.prepare('UPDATE swarm_runs SET total_tokens_in = 999 WHERE id = ?').run(runId);
    const result = wire().reconcileSwarmRun(runId);
    expect(result.match).toBe(false);
    expect(result.drift).toContainEqual(expect.objectContaining({ scope: 'run', field: 'totalTokensIn', rebuilt: 30, stored: 999 }));
    db.close();
  });
});
