// 第四期 步骤4：偏差自愈写闸门集成验证（真实 in-memory sqlite）。
// 证明：写闸门开 → drift 被「从 ledger 确定性重建」对齐、且幂等；写闸门关（默认）→ 绝不改写。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import { SwarmTraceRepository } from '../../../src/host/services/core/repositories/SwarmTraceRepository';
import { SwarmLedgerRepository } from '../../../src/host/services/core/repositories/SwarmLedgerRepository';
import {
  runReconcileScan,
  createDatabaseRebuildWriter,
  type ReconcileScanReader,
} from '../../../src/host/services/core/swarmReconcileService';

const NOW = 1_700_000_000_000;
const RUN = 'run-int-1';
const createLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function seed(db: BetterSqlite3.Database) {
  const trace = new SwarmTraceRepository(db);
  const ledger = new SwarmLedgerRepository(db);
  // ledger（真理源）
  ledger.append({ runId: RUN, sessionId: 's1', seq: 0, kind: 'run_started', agentId: null, payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' }, recordedAt: 100 });
  ledger.append({ runId: RUN, sessionId: 's1', seq: 1, kind: 'agent_snapshot', agentId: 'a1', payload: { agentId: 'a1', name: 'a1', role: 'worker', status: 'completed', startTime: 100, endTime: 200, durationMs: 100, tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [] }, recordedAt: 101 });
  ledger.append({ runId: RUN, sessionId: 's1', seq: 2, kind: 'run_closed', agentId: null, payload: { status: 'completed', endedAt: 300, completedCount: 1, failedCount: 0, parallelPeak: 1, totalTokensIn: 10, totalTokensOut: 5, totalToolCalls: 1, totalCostUsd: 0.01, errorSummary: null, aggregation: null, tags: [] }, recordedAt: 102 });
  // rollup（初始与 ledger 一致）
  trace.startRun({ id: RUN, sessionId: 's1', coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' });
  trace.upsertAgent({ runId: RUN, agentId: 'a1', name: 'a1', role: 'worker', status: 'completed', startTime: 100, endTime: 200, durationMs: 100, tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [] });
  trace.closeRun({ id: RUN, status: 'completed', endedAt: 300, completedCount: 1, failedCount: 0, parallelPeak: 1, totalTokensIn: 10, totalTokensOut: 5, totalToolCalls: 1, totalCostUsd: 0.01, errorSummary: null, aggregation: null });
  return { trace, ledger };
}

function makeReader(trace: SwarmTraceRepository, ledger: SwarmLedgerRepository): ReconcileScanReader {
  return {
    listRunIds: () => ledger.listRunIds(),
    getLedgerByRun: (id) => ledger.getByRun(id),
    getStoredRunDetail: (id) => trace.getRunDetail(id),
  };
}

describe('偏差自愈集成（真实 sqlite · 写闸门）', () => {
  let db: BetterSqlite3.Database;
  afterEach(() => { try { db?.close(); } catch { /* ignore */ } });

  it('写闸门开 → drift 被确定性重建对齐 ledger，且幂等（再扫不再重建）', () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    const { trace, ledger } = seed(db);
    db.prepare('UPDATE swarm_runs SET total_tool_calls = 999 WHERE id = ?').run(RUN); // 篡改 rollup 制造 drift
    expect(trace.getRunDetail(RUN)!.run.totalToolCalls).toBe(999);

    const reader = makeReader(trace, ledger);
    const writer = createDatabaseRebuildWriter(trace);

    const r1 = runReconcileScan(reader, { now: NOW, rebuildOnDrift: true, rebuildWriter: writer });
    expect(r1.rebuilt).toEqual([RUN]);
    expect(trace.getRunDetail(RUN)!.run.totalToolCalls).toBe(1); // 重建回 ledger 真理值

    const r2 = runReconcileScan(reader, { now: NOW, rebuildOnDrift: true, rebuildWriter: writer });
    expect(r2.matched).toBe(1);
    expect(r2.rebuilt).toEqual([]); // 已对齐 → 幂等，不再重建
    expect(r2.drifted).toEqual([]);
  });

  it('写闸门关（默认）→ drift 不被改写', () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    const { trace, ledger } = seed(db);
    db.prepare('UPDATE swarm_runs SET total_tool_calls = 999 WHERE id = ?').run(RUN);

    const r = runReconcileScan(makeReader(trace, ledger), { now: NOW }); // 默认关
    expect(r.drifted).toHaveLength(1);
    expect(r.rebuilt).toEqual([]);
    expect(trace.getRunDetail(RUN)!.run.totalToolCalls).toBe(999); // 未改写
  });
});
