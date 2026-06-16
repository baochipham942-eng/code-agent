// 3b 步骤2：SwarmTraceWriter 并行追加协同事件账本（不动现有 rollup 写入）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/main/services/core/database/schema';
import { SwarmTraceRepository } from '../../../src/main/services/core/repositories/SwarmTraceRepository';
import { SwarmLedgerRepository } from '../../../src/main/services/core/repositories/SwarmLedgerRepository';
import { SwarmTraceWriter } from '../../../src/main/agent/swarmTraceWriter';
import { SwarmEventEmitter } from '../../../src/main/agent/swarmEventPublisher';
import { shutdownEventBus } from '../../../src/main/services/eventing/bus';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('SwarmTraceWriter · 3b 并行追加协同事件账本', () => {
  let db: BetterSqlite3.Database;
  let repo: SwarmTraceRepository;
  let ledger: SwarmLedgerRepository;
  let writer: SwarmTraceWriter;
  let emitter: SwarmEventEmitter;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    repo = new SwarmTraceRepository(db);
    ledger = new SwarmLedgerRepository(db);
    writer = new SwarmTraceWriter(repo, {
      getSessionId: () => 'sess-test',
      defaultTrigger: 'llm-spawn',
      defaultCoordinator: 'hybrid',
      appendLedger: (input) => ledger.append(input),
    });
    writer.install();
    emitter = new SwarmEventEmitter();
  });

  afterEach(async () => {
    await writer.dispose();
    db.close();
    shutdownEventBus();
  });

  it('完整生命周期后账本成套：run_started + 各 agent_snapshot + run_closed，按 seq 单调', async () => {
    emitter.started(1);
    const runId = emitter.getCurrentRunId()!;
    emitter.agentAdded({ id: 'a1', name: 'Coder', role: 'coder' });
    emitter.agentUpdated('a1', { status: 'running', startTime: 100, iterations: 1, tokenUsage: { input: 10, output: 5 }, toolCalls: 1 });
    emitter.agentUpdated('a1', { status: 'running', startTime: 100, iterations: 2, tokenUsage: { input: 30, output: 15 }, toolCalls: 3 });
    emitter.agentCompleted('a1', 'done');
    emitter.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 500 });
    await writer.drain();

    const events = ledger.getByRun(runId);
    // seq 单调递增
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('run_started');
    expect(kinds.at(-1)).toBe('run_closed');
    expect(kinds.filter((k) => k === 'agent_snapshot').length).toBeGreaterThanOrEqual(3); // added+2 updates+completed
    // 末条 agent_snapshot 是 completed 末值（tokensIn=30）
    const agentSnaps = events.filter((e) => e.kind === 'agent_snapshot' && e.agentId === 'a1');
    expect(agentSnaps.at(-1)!.payload).toMatchObject({ status: 'completed', tokensIn: 30, toolCalls: 3 });
    // run_closed 携带收尾统计
    expect(events.at(-1)!.payload).toMatchObject({ status: 'completed', totalTokensIn: 30, totalTokensOut: 15 });
  });

  it('现有 rollup 写入路径不受影响（回归）', async () => {
    emitter.started(1);
    const runId = emitter.getCurrentRunId()!;
    emitter.agentAdded({ id: 'a1', name: 'Coder', role: 'coder' });
    emitter.agentUpdated('a1', { status: 'running', startTime: 100, iterations: 1, tokenUsage: { input: 30, output: 15 }, toolCalls: 3 });
    emitter.agentCompleted('a1', 'done');
    emitter.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 500 });
    await writer.drain();

    const detail = repo.getRunDetail(runId)!;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.totalTokensIn).toBe(30);
    expect(detail.agents[0].toolCalls).toBe(3);
  });

  it('appendLedger 抛错不影响 swarm 运行与 rollup 持久化（fail-safe）', async () => {
    await writer.dispose();
    shutdownEventBus();
    const boomWriter = new SwarmTraceWriter(repo, {
      getSessionId: () => 'sess-test',
      appendLedger: () => { throw new Error('ledger boom'); },
    });
    boomWriter.install();
    const em = new SwarmEventEmitter();
    em.started(1);
    const runId = em.getCurrentRunId()!;
    em.agentAdded({ id: 'a1', name: 'Coder', role: 'coder' });
    em.agentCompleted('a1', 'done');
    em.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 100 });
    await expect(boomWriter.drain()).resolves.toBeUndefined(); // 不抛
    expect(repo.getRunDetail(runId)!.run.status).toBe('completed'); // rollup 照常落库
    await boomWriter.dispose();
  });
});
