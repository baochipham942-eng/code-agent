// ============================================================================
// SwarmTraceRepository Tests — ADR-010 #5
// ============================================================================
//
// 使用真实 better-sqlite3 in-memory 数据库覆盖：
//   - startRun / closeRun lifecycle 与字段聚合
//   - upsertAgent ON CONFLICT 行为
//   - appendEvent 单 run 上限与 payload 截断
//   - listRuns 按 started_at desc 排序 + limit clamp
//   - getRunDetail 拼装三表
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { SwarmTraceRepository } from '../../../src/main/services/core/repositories/SwarmTraceRepository';
import { SWARM_TRACE } from '../../../src/shared/constants/storage';

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

describe('SwarmTraceRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: SwarmTraceRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    repo = new SwarmTraceRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // Run lifecycle
  // --------------------------------------------------------------------------

  it('startRun 写入初始字段并默认 status=running', () => {
    repo.startRun({
      id: 'run-1',
      sessionId: 'sess-1',
      coordinator: 'hybrid',
      startedAt: 1_000,
      totalAgents: 3,
      trigger: 'llm-spawn',
    });

    const detail = repo.getRunDetail('run-1');
    expect(detail).not.toBeNull();
    expect(detail!.run.status).toBe('running');
    expect(detail!.run.totalAgents).toBe(3);
    expect(detail!.run.trigger).toBe('llm-spawn');
    expect(detail!.run.endedAt).toBeNull();
    expect(detail!.run.aggregation).toBeNull();
  });

  it('closeRun 聚合写入 status / counts / 总量 / aggregation', () => {
    repo.startRun({
      id: 'run-1',
      sessionId: null,
      coordinator: 'parallel',
      startedAt: 1_000,
      totalAgents: 2,
      trigger: 'ui-launch',
    });
    repo.closeRun({
      id: 'run-1',
      status: 'completed',
      endedAt: 2_500,
      completedCount: 2,
      failedCount: 0,
      parallelPeak: 2,
      totalTokensIn: 1234,
      totalTokensOut: 567,
      totalToolCalls: 8,
      totalCostUsd: 0.42,
      errorSummary: null,
      aggregation: {
        summary: 'ok',
        filesChanged: ['a.ts'],
        totalCost: 0.42,
        totalDuration: 1500,
        speedup: 1.6,
        successRate: 1,
        totalIterations: 4,
      },
    });

    const detail = repo.getRunDetail('run-1')!;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.endedAt).toBe(2_500);
    expect(detail.run.totalTokensIn).toBe(1234);
    expect(detail.run.totalCostUsd).toBeCloseTo(0.42);
    expect(detail.run.aggregation?.speedup).toBeCloseTo(1.6);
    expect(detail.run.aggregation?.filesChanged).toEqual(['a.ts']);
  });

  it('重复 startRun(同 id) 等价于 reset，status 回到 running', () => {
    repo.startRun({
      id: 'run-1',
      sessionId: null,
      coordinator: 'hybrid',
      startedAt: 1_000,
      totalAgents: 2,
      trigger: 'auto',
    });
    repo.closeRun({
      id: 'run-1',
      status: 'failed',
      endedAt: 2_000,
      completedCount: 0,
      failedCount: 2,
      parallelPeak: 1,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalToolCalls: 0,
      totalCostUsd: 0,
      errorSummary: 'boom',
      aggregation: null,
    });

    repo.startRun({
      id: 'run-1',
      sessionId: null,
      coordinator: 'hybrid',
      startedAt: 5_000,
      totalAgents: 1,
      trigger: 'auto',
    });

    const detail = repo.getRunDetail('run-1')!;
    expect(detail.run.status).toBe('running');
    expect(detail.run.startedAt).toBe(5_000);
    expect(detail.run.totalAgents).toBe(1);
    expect(detail.run.errorSummary).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Agents
  // --------------------------------------------------------------------------

  it('upsertAgent 重复写入按 (run_id, agent_id) 覆盖', () => {
    repo.startRun({
      id: 'run-1', sessionId: null, coordinator: 'parallel',
      startedAt: 0, totalAgents: 1, trigger: 'llm-spawn',
    });

    repo.upsertAgent({
      runId: 'run-1', agentId: 'a1', name: 'Coder', role: 'coder',
      status: 'running', startTime: 100, endTime: null, durationMs: null,
      tokensIn: 10, tokensOut: 20, toolCalls: 1, costUsd: 0.01,
      error: null, failureCategory: null, filesChanged: [],
    });

    repo.upsertAgent({
      runId: 'run-1', agentId: 'a1', name: 'Coder', role: 'coder',
      status: 'completed', startTime: 100, endTime: 500, durationMs: 400,
      tokensIn: 50, tokensOut: 80, toolCalls: 4, costUsd: 0.05,
      error: null, failureCategory: null, filesChanged: ['x.ts', 'y.ts'],
    });

    const detail = repo.getRunDetail('run-1')!;
    expect(detail.agents).toHaveLength(1);
    expect(detail.agents[0].status).toBe('completed');
    expect(detail.agents[0].tokensIn).toBe(50);
    expect(detail.agents[0].filesChanged).toEqual(['x.ts', 'y.ts']);
  });

  it('upsertAgent 失败记录保留 error 与 failure_category', () => {
    repo.startRun({
      id: 'run-1', sessionId: null, coordinator: 'parallel',
      startedAt: 0, totalAgents: 1, trigger: 'llm-spawn',
    });

    repo.upsertAgent({
      runId: 'run-1', agentId: 'a1', name: 'A', role: 'a',
      status: 'failed', startTime: 0, endTime: 100, durationMs: 100,
      tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0,
      error: 'tool timeout', failureCategory: 'timeout', filesChanged: [],
    });

    const agents = repo.getRunDetail('run-1')!.agents;
    expect(agents[0].error).toBe('tool timeout');
    expect(agents[0].failureCategory).toBe('timeout');
  });

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  it('appendEvent 按 seq 顺序写入并可读出', () => {
    repo.startRun({
      id: 'run-1', sessionId: null, coordinator: 'hybrid',
      startedAt: 0, totalAgents: 0, trigger: 'auto',
    });
    repo.appendEvent({
      runId: 'run-1', seq: 0, timestamp: 1, eventType: 'swarm:started',
      agentId: null, level: 'info', title: 'started', summary: '', payload: { total: 2 },
    });
    repo.appendEvent({
      runId: 'run-1', seq: 1, timestamp: 2, eventType: 'swarm:agent:added',
      agentId: 'a1', level: 'info', title: 'added', summary: 'a1', payload: null,
    });

    const events = repo.getRunDetail('run-1')!.events;
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0].payload).toEqual({ total: 2 });
  });

  it('appendEvent 超过 MAX_EVENTS_PER_RUN 后丢弃后续', () => {
    repo.startRun({
      id: 'run-1', sessionId: null, coordinator: 'hybrid',
      startedAt: 0, totalAgents: 0, trigger: 'auto',
    });

    const cap = SWARM_TRACE.MAX_EVENTS_PER_RUN;
    // 写超过上限，越界部分应被丢弃
    for (let i = 0; i < cap + 5; i++) {
      repo.appendEvent({
        runId: 'run-1', seq: i, timestamp: i, eventType: 'noise',
        agentId: null, level: 'debug', title: '', summary: '', payload: null,
      });
    }

    const events = repo.getRunDetail('run-1')!.events;
    expect(events.length).toBe(cap);
  });

  it('appendEvent payload 超过字节上限会截断', () => {
    repo.startRun({
      id: 'run-1', sessionId: null, coordinator: 'hybrid',
      startedAt: 0, totalAgents: 0, trigger: 'auto',
    });

    const huge = 'x'.repeat(SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES * 2);
    repo.appendEvent({
      runId: 'run-1', seq: 0, timestamp: 1, eventType: 'noise',
      agentId: null, level: 'info', title: '', summary: '', payload: { blob: huge },
    });

    const ev = repo.getRunDetail('run-1')!.events[0];
    const payload = ev.payload as { _truncated?: boolean; preview?: string };
    expect(payload._truncated).toBe(true);
    expect(typeof payload.preview).toBe('string');
  });

  // --------------------------------------------------------------------------
  // List
  // --------------------------------------------------------------------------

  it('listRuns 按 started_at DESC 排序', () => {
    repo.startRun({ id: 'r1', sessionId: null, coordinator: 'hybrid', startedAt: 100, totalAgents: 0, trigger: 'auto' });
    repo.startRun({ id: 'r2', sessionId: null, coordinator: 'hybrid', startedAt: 300, totalAgents: 0, trigger: 'auto' });
    repo.startRun({ id: 'r3', sessionId: null, coordinator: 'hybrid', startedAt: 200, totalAgents: 0, trigger: 'auto' });

    const list = repo.listRuns(50);
    expect(list.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('listRuns clamp 到 MAX_LIST_LIMIT', () => {
    for (let i = 0; i < 5; i++) {
      repo.startRun({
        id: `r${i}`, sessionId: null, coordinator: 'hybrid',
        startedAt: i, totalAgents: 0, trigger: 'auto',
      });
    }
    expect(repo.listRuns(99999).length).toBe(5);
    expect(repo.listRuns(0).length).toBeLessThanOrEqual(SWARM_TRACE.MAX_LIST_LIMIT);
  });

  it('listRuns 含 durationMs（ended 后才有值）', () => {
    repo.startRun({ id: 'r1', sessionId: null, coordinator: 'hybrid', startedAt: 100, totalAgents: 0, trigger: 'auto' });
    repo.closeRun({
      id: 'r1', status: 'completed', endedAt: 350,
      completedCount: 0, failedCount: 0, parallelPeak: 0,
      totalTokensIn: 0, totalTokensOut: 0, totalToolCalls: 0, totalCostUsd: 0,
      errorSummary: null, aggregation: null,
    });
    repo.startRun({ id: 'r2', sessionId: null, coordinator: 'hybrid', startedAt: 200, totalAgents: 0, trigger: 'auto' });

    const list = repo.listRuns(10);
    const r1 = list.find((r) => r.id === 'r1')!;
    const r2 = list.find((r) => r.id === 'r2')!;
    expect(r1.durationMs).toBe(250);
    expect(r2.durationMs).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Detail / delete
  // --------------------------------------------------------------------------

  it('getRunDetail 不存在返回 null', () => {
    expect(repo.getRunDetail('nope')).toBeNull();
  });

  it('deleteRun 级联清掉 agents 与 events', () => {
    repo.startRun({ id: 'r1', sessionId: null, coordinator: 'hybrid', startedAt: 1, totalAgents: 1, trigger: 'auto' });
    repo.upsertAgent({
      runId: 'r1', agentId: 'a', name: 'a', role: 'a', status: 'running',
      startTime: 0, endTime: null, durationMs: null,
      tokensIn: 0, tokensOut: 0, toolCalls: 0, costUsd: 0,
      error: null, failureCategory: null, filesChanged: [],
    });
    repo.appendEvent({
      runId: 'r1', seq: 0, timestamp: 1, eventType: 'swarm:started',
      agentId: null, level: 'info', title: '', summary: '', payload: null,
    });

    expect(repo.deleteRun('r1')).toBe(true);
    expect(repo.getRunDetail('r1')).toBeNull();
    const agentRows = db.prepare('SELECT COUNT(*) as c FROM swarm_run_agents').get() as { c: number };
    const eventRows = db.prepare('SELECT COUNT(*) as c FROM swarm_run_events').get() as { c: number };
    expect(agentRows.c).toBe(0);
    expect(eventRows.c).toBe(0);
  });
});
