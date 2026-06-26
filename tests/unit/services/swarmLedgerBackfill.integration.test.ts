// 第四期 步骤5：存量老库迁移（B1 默认跳过 + opt-in backfill）集成验证（真实 in-memory sqlite）。
// 证明：① 旧库（有 rollup、无 ledger）不迁移也能正常读；② opt-in backfill 反向重建 ledger 且与
// rollup 对账一致；③ 幂等（重跑全跳过、无重复）；④ 事务回滚（中途出错不留脏数据、不毁老库）。
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
import { rebuildRunDetail } from '../../../src/host/services/core/swarmRollupProjection';
import { reconcileRun } from '../../../src/host/services/core/swarmReconcile';
import {
  backfillSwarmLedger,
  type SwarmLedgerBackfillDeps,
} from '../../../src/host/services/core/database/backfillSwarmLedger';
import type { SwarmLedgerAppendInput } from '../../../src/shared/contract/swarmLedger';

const NOW = 1_700_000_000_000;
const RUN = 'run-old-1';
const createLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** 只写 rollup（旧库：无 ledger）。 */
function seedRollupOnly(db: BetterSqlite3.Database) {
  const trace = new SwarmTraceRepository(db);
  trace.startRun({ id: RUN, sessionId: 's1', coordinator: 'hybrid', startedAt: 100, totalAgents: 1, trigger: 'auto' });
  trace.upsertAgent({ runId: RUN, agentId: 'a1', name: 'a1', role: 'worker', status: 'completed', startTime: 100, endTime: 200, durationMs: 100, tokensIn: 10, tokensOut: 5, toolCalls: 1, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [] });
  trace.closeRun({ id: RUN, status: 'completed', endedAt: 300, completedCount: 1, failedCount: 0, parallelPeak: 1, totalTokensIn: 10, totalTokensOut: 5, totalToolCalls: 1, totalCostUsd: 0.01, errorSummary: null, aggregation: null });
}

function makeDeps(db: BetterSqlite3.Database, override?: Partial<SwarmLedgerBackfillDeps>): SwarmLedgerBackfillDeps {
  const trace = new SwarmTraceRepository(db);
  const ledger = new SwarmLedgerRepository(db);
  return {
    listRunIds: () => trace.listRuns(1000).map((r) => r.id),
    getStoredRunDetail: (id) => trace.getRunDetail(id),
    hasLedger: (id) => ledger.getByRun(id).length > 0,
    appendLedger: (input: SwarmLedgerAppendInput) => ledger.append(input),
    transaction: (fn: () => void) => db.transaction(fn)(),
    now: NOW,
    ...override,
  };
}

describe('backfillSwarmLedger（老库迁移 · 真实 sqlite）', () => {
  let db: BetterSqlite3.Database;
  afterEach(() => { try { db?.close(); } catch { /* ignore */ } });

  it('旧库不迁移也能正常读（向后兼容）；opt-in backfill 后 ledger 与 rollup 对账一致', () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    seedRollupOnly(db);
    const trace = new SwarmTraceRepository(db);
    const ledger = new SwarmLedgerRepository(db);

    // ① 不迁移也能读
    expect(trace.getRunDetail(RUN)).not.toBeNull();
    expect(ledger.getByRun(RUN)).toHaveLength(0);

    // ② opt-in backfill
    const res = backfillSwarmLedger(makeDeps(db));
    expect(res.backfilled).toEqual([RUN]);
    const events = ledger.getByRun(RUN);
    expect(events.length).toBeGreaterThanOrEqual(3); // run_started + agent_snapshot + run_closed
    const reconciled = reconcileRun(rebuildRunDetail(events), trace.getRunDetail(RUN), RUN);
    expect(reconciled.match).toBe(true); // 重建 == 原 rollup
  });

  it('幂等：重跑 backfill 全跳过(already-ledgered)，无重复写入', () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    seedRollupOnly(db);
    const ledger = new SwarmLedgerRepository(db);

    backfillSwarmLedger(makeDeps(db));
    const countAfterFirst = ledger.getByRun(RUN).length;

    const res2 = backfillSwarmLedger(makeDeps(db));
    expect(res2.backfilled).toEqual([]);
    expect(res2.skipped.some((s) => s.runId === RUN && s.note === 'already-ledgered')).toBe(true);
    expect(ledger.getByRun(RUN).length).toBe(countAfterFirst); // 无重复
  });

  it('事务回滚：中途出错不留脏数据、不毁老库', () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    seedRollupOnly(db);
    const ledger = new SwarmLedgerRepository(db);

    let calls = 0;
    const failingAppend = (input: SwarmLedgerAppendInput) => {
      calls += 1;
      if (calls === 2) throw new Error('append boom'); // 在 agent_snapshot 处炸
      ledger.append(input);
    };
    const res = backfillSwarmLedger(makeDeps(db, { appendLedger: failingAppend }));

    expect(res.errors.some((e) => e.runId === RUN && e.error.includes('boom'))).toBe(true);
    expect(res.backfilled).toEqual([]);
    expect(ledger.getByRun(RUN)).toHaveLength(0); // 事务回滚，run_started 也不残留
    expect(new SwarmTraceRepository(db).getRunDetail(RUN)).not.toBeNull(); // 老库 rollup 完好
  });
});
