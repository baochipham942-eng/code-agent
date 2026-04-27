// ============================================================================
// SwarmTraceWriter Tests — ADR-010 #5
// ============================================================================
//
// 通过真实 in-memory better-sqlite3 + 真实 EventBus 验证：
//   - SwarmEventEmitter.started 生成 runId 并打戳后续事件
//   - SwarmTraceWriter 订阅 EventBus 后能完成 startRun / upsertAgent /
//     appendEvent / closeRun 全闭环
//   - completed / cancelled 后 currentRunId 清空
//   - drain() 等待串行链落盘
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { SwarmTraceRepository } from '../../../src/main/services/core/repositories/SwarmTraceRepository';
import { SwarmTraceWriter } from '../../../src/main/agent/swarmTraceWriter';
import { SwarmEventEmitter } from '../../../src/main/agent/swarmEventPublisher';
import { shutdownEventBus } from '../../../src/main/services/eventing/bus';

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE swarm_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      coordinator TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      total_agents INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      parallel_peak INTEGER NOT NULL DEFAULT 0,
      total_tokens_in INTEGER NOT NULL DEFAULT 0,
      total_tokens_out INTEGER NOT NULL DEFAULT 0,
      total_tool_calls INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT 'unknown',
      error_summary TEXT,
      aggregation_json TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE swarm_run_agents (
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      duration_ms INTEGER,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      failure_category TEXT,
      files_changed_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (run_id, agent_id),
      FOREIGN KEY (run_id) REFERENCES swarm_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE swarm_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      FOREIGN KEY (run_id) REFERENCES swarm_runs(id) ON DELETE CASCADE
    );
  `);
}

describe('SwarmTraceWriter', () => {
  let db: BetterSqlite3.Database;
  let repo: SwarmTraceRepository;
  let writer: SwarmTraceWriter;
  let emitter: SwarmEventEmitter;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    repo = new SwarmTraceRepository(db);
    writer = new SwarmTraceWriter(repo, {
      getSessionId: () => 'sess-test',
      defaultTrigger: 'llm-spawn',
      defaultCoordinator: 'hybrid',
    });
    writer.install();
    emitter = new SwarmEventEmitter();
  });

  afterEach(async () => {
    await writer.dispose();
    db.close();
    shutdownEventBus();
  });

  it('SwarmEventEmitter.started 生成 runId 并打戳后续事件', async () => {
    expect(emitter.getCurrentRunId()).toBeNull();
    emitter.started(2);
    const runId = emitter.getCurrentRunId();
    expect(runId).not.toBeNull();
    await writer.drain();

    const detail = repo.getRunDetail(runId!);
    expect(detail).not.toBeNull();
    expect(detail!.run.totalAgents).toBe(2);
    expect(detail!.run.sessionId).toBe('sess-test');
    expect(detail!.run.trigger).toBe('llm-spawn');
    expect(detail!.run.coordinator).toBe('hybrid');
  });

  it('uses sessionId from swarm:started event when present', async () => {
    emitter.started(1, 'sess-event');
    const runId = emitter.getCurrentRunId();
    await writer.drain();

    const detail = repo.getRunDetail(runId!);
    expect(detail?.run.sessionId).toBe('sess-event');
  });

  it('agent lifecycle 写入 rollup', async () => {
    emitter.started(1);
    const runId = emitter.getCurrentRunId()!;

    emitter.agentAdded({ id: 'a1', name: 'Coder', role: 'coder' });
    emitter.agentUpdated('a1', {
      status: 'running',
      startTime: 100,
      iterations: 1,
      tokenUsage: { input: 10, output: 5 },
      toolCalls: 1,
    });
    emitter.agentUpdated('a1', {
      status: 'running',
      startTime: 100,
      iterations: 2,
      tokenUsage: { input: 30, output: 15 },
      toolCalls: 3,
    });
    emitter.agentCompleted('a1', 'done');
    emitter.completed({
      total: 1,
      completed: 1,
      failed: 0,
      parallelPeak: 1,
      totalTime: 500,
    });

    await writer.drain();

    const detail = repo.getRunDetail(runId)!;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.endedAt).not.toBeNull();
    expect(detail.run.totalTokensIn).toBe(30);
    expect(detail.run.totalTokensOut).toBe(15);
    expect(detail.agents).toHaveLength(1);
    expect(detail.agents[0].toolCalls).toBe(3);
    // timeline 至少包含 started / added / updated / completed
    expect(detail.events.length).toBeGreaterThanOrEqual(4);
    expect(detail.events.map((event) => event.eventType)).toContain('swarm:completed');
    expect(detail.events.every((e) => e.runId === runId)).toBe(true);
  });

  it('failed agent 记录 error 与 failure_category', async () => {
    emitter.started(1);
    const runId = emitter.getCurrentRunId()!;
    emitter.agentAdded({ id: 'a1', name: 'A', role: 'a' });
    emitter.agentUpdated('a1', { status: 'running', startTime: 0 });
    emitter.agentFailed('a1', 'request timeout after 30000ms');
    emitter.completed({ total: 1, completed: 0, failed: 1, parallelPeak: 1, totalTime: 100 });

    await writer.drain();

    const detail = repo.getRunDetail(runId)!;
    expect(detail.run.status).toBe('failed');
    expect(detail.agents[0].error).toContain('timeout');
    expect(detail.agents[0].failureCategory).toBe('timeout');
    expect(detail.run.errorSummary).toContain('timeout');
  });

  it('cancelled 在事件之后清空 currentRunId 并标记 status', async () => {
    emitter.started(2);
    const runId = emitter.getCurrentRunId()!;
    emitter.agentAdded({ id: 'a1', name: 'A', role: 'a' });
    emitter.cancelled();
    expect(emitter.getCurrentRunId()).toBeNull();
    await writer.drain();

    const detail = repo.getRunDetail(runId)!;
    expect(detail.run.status).toBe('cancelled');
    expect(detail.run.endedAt).not.toBeNull();
    expect(detail.events.map((event) => event.eventType)).toContain('swarm:cancelled');
  });

  it('两次 started 产生两个独立 run', async () => {
    emitter.started(1);
    const r1 = emitter.getCurrentRunId()!;
    emitter.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 10 });
    emitter.started(2);
    const r2 = emitter.getCurrentRunId()!;
    emitter.completed({ total: 2, completed: 2, failed: 0, parallelPeak: 2, totalTime: 20 });
    await writer.drain();

    expect(r1).not.toBe(r2);
    expect(repo.getRunDetail(r1)?.run.totalAgents).toBe(1);
    expect(repo.getRunDetail(r2)?.run.totalAgents).toBe(2);
  });

  it('listRuns 按 started_at desc 包含两次 run', async () => {
    emitter.started(1);
    emitter.completed({ total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 10 });
    emitter.started(2);
    emitter.completed({ total: 2, completed: 2, failed: 0, parallelPeak: 2, totalTime: 20 });
    await writer.drain();

    const list = repo.listRuns(10);
    expect(list.length).toBe(2);
    expect(list[0].startedAt).toBeGreaterThanOrEqual(list[1].startedAt);
  });
});
