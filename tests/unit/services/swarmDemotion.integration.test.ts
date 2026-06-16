// 3b 步骤5：切换降级——getSwarmRunDetailPreferLedger 以 ledger 为真理源、rollup 退为回退缓存。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

vi.mock('../../../src/main/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import { applySchema } from '../../../src/main/services/core/database/schema';
import { DatabaseService } from '../../../src/main/services/core/databaseService';
import { SwarmTraceRepository } from '../../../src/main/services/core/repositories/SwarmTraceRepository';
import { SwarmLedgerRepository } from '../../../src/main/services/core/repositories/SwarmLedgerRepository';
import { SwarmTraceWriter } from '../../../src/main/agent/swarmTraceWriter';
import { SwarmEventEmitter } from '../../../src/main/agent/swarmEventPublisher';
import { shutdownEventBus } from '../../../src/main/services/eventing/bus';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('getSwarmRunDetailPreferLedger（3b 切换降级）', () => {
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

  async function driveRun(appendLedger: boolean): Promise<string> {
    const repo = new SwarmTraceRepository(db);
    const ledger = new SwarmLedgerRepository(db);
    const writer = new SwarmTraceWriter(repo, {
      getSessionId: () => 's1',
      ...(appendLedger ? { appendLedger: (input) => ledger.append(input) } : {}),
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
    return runId;
  }

  afterEach(() => { shutdownEventBus(); vi.restoreAllMocks(); if (db && db.open) db.close(); });

  it('有账 + rollup 被改坏 → 读出以 ledger 为准（真理源已切换）；events 仍来自缓存', async () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    const runId = await driveRun(true);
    // 篡改 rollup 表
    db.prepare('UPDATE swarm_runs SET total_tokens_in = 999 WHERE id = ?').run(runId);
    db.prepare('UPDATE swarm_run_agents SET tokens_in = 999 WHERE run_id = ?').run(runId);

    const detail = wire().getSwarmRunDetailPreferLedger(runId)!;
    expect(detail.run.totalTokensIn).toBe(30);       // 以 ledger 为准，不是被改坏的 999
    expect(detail.agents[0].tokensIn).toBe(30);       // agent 同样以 ledger 为准
    expect(detail.events.length).toBeGreaterThan(0);  // timeline 仍来自 rollup 缓存
  });

  it('无账的历史 run → 回退 rollup 缓存（兼容老数据，不丢）', async () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    const runId = await driveRun(false); // 不写 ledger，模拟降级前的历史 run

    const detail = wire().getSwarmRunDetailPreferLedger(runId)!;
    expect(detail).not.toBeNull();
    expect(detail.run.totalTokensIn).toBe(30);        // 回退 rollup 读出
    expect(detail.agents).toHaveLength(1);
  });

  it('既无账也无 rollup → null（不抛）', async () => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    expect(wire().getSwarmRunDetailPreferLedger('nope')).toBeNull();
  });
});
