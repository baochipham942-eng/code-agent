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

import { SwarmTraceRepository } from '../../../src/host/services/core/repositories/SwarmTraceRepository';
import { SwarmTraceWriter } from '../../../src/host/agent/swarmTraceWriter';
import { SwarmEventEmitter } from '../../../src/host/agent/swarmEventPublisher';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import {
  createSwarmTraceStorageId,
  type SwarmAgentState,
  type SwarmEvent,
  type SwarmExecutionState,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';

let scopeCounter = 0;
function makeScope(sessionId = 'sess-test'): SwarmRunScope {
  const id = ++scopeCounter;
  return { sessionId, runId: `run-${id}`, treeId: `tree-${id}` };
}

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

function makeStats(total: number, overrides: Partial<SwarmExecutionState['statistics']> = {}): SwarmExecutionState['statistics'] {
  return {
    total,
    completed: 0,
    failed: 0,
    running: 0,
    pending: total,
    parallelPeak: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    ...overrides,
  };
}

function makeAgent(id: string, status: SwarmAgentState['status']): SwarmAgentState {
  return {
    id,
    name: id,
    role: 'coder',
    status,
    iterations: 0,
  };
}

function publishSwarm(event: SwarmEvent): void {
  const busType = event.type.startsWith('swarm:') ? event.type.slice(6) : event.type;
  getEventBus().publish('swarm', busType, event, {
    sessionId: event.sessionId,
    bridgeToRenderer: false,
  });
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

  it('SwarmEventEmitter 使用调用方提供的完整 scope', async () => {
    const scope = makeScope();
    emitter.started(scope, 2);
    await writer.drain();

    const detail = repo.getRunDetail(createSwarmTraceStorageId(scope));
    expect(detail).not.toBeNull();
    expect(detail!.run.totalAgents).toBe(2);
    expect(detail!.run.sessionId).toBe('sess-test');
    expect(detail!.run.trigger).toBe('llm-spawn');
    expect(detail!.run.coordinator).toBe('hybrid');
  });

  it('uses sessionId from swarm:started event when present', async () => {
    const scope = makeScope('sess-event');
    emitter.started(scope, 1);
    await writer.drain();

    const detail = repo.getRunDetail(createSwarmTraceStorageId(scope));
    expect(detail?.run.sessionId).toBe('sess-event');
  });

  it('agent lifecycle 写入 rollup', async () => {
    const scope = makeScope();
    emitter.started(scope, 1);

    emitter.agentAdded(scope, { id: 'a1', name: 'Coder', role: 'coder' });
    emitter.agentUpdated(scope, 'a1', {
      status: 'running',
      startTime: 100,
      iterations: 1,
      tokenUsage: { input: 10, output: 5 },
      toolCalls: 1,
    });
    emitter.agentUpdated(scope, 'a1', {
      status: 'running',
      startTime: 100,
      iterations: 2,
      tokenUsage: { input: 30, output: 15 },
      toolCalls: 3,
    });
    emitter.agentCompleted(scope, 'a1', 'done');
    emitter.completed(scope, {
      total: 1,
      completed: 1,
      failed: 0,
      parallelPeak: 1,
      totalTime: 500,
    });

    await writer.drain();

    const storageRunId = createSwarmTraceStorageId(scope);
    const detail = repo.getRunDetail(storageRunId)!;
    expect(detail.run.status).toBe('completed');
    expect(detail.run.endedAt).not.toBeNull();
    expect(detail.run.totalTokensIn).toBe(30);
    expect(detail.run.totalTokensOut).toBe(15);
    expect(detail.agents).toHaveLength(1);
    expect(detail.agents[0].toolCalls).toBe(3);
    // timeline 至少包含 started / added / updated / completed
    expect(detail.events.length).toBeGreaterThanOrEqual(4);
    expect(detail.events.map((event) => event.eventType)).toContain('swarm:completed');
    expect(detail.events.every((e) => e.runId === storageRunId)).toBe(true);
  });

  it('failed agent 记录 error 与 failure_category', async () => {
    const scope = makeScope();
    emitter.started(scope, 1);
    emitter.agentAdded(scope, { id: 'a1', name: 'A', role: 'a' });
    emitter.agentUpdated(scope, 'a1', { status: 'running', startTime: 0 });
    emitter.agentFailed(scope, 'a1', 'request timeout after 30000ms');
    emitter.completed(scope, { total: 1, completed: 0, failed: 1, parallelPeak: 1, totalTime: 100 });

    await writer.drain();

    const detail = repo.getRunDetail(createSwarmTraceStorageId(scope))!;
    expect(detail.run.status).toBe('failed');
    expect(detail.agents[0].error).toContain('timeout');
    expect(detail.agents[0].failureCategory).toBe('timeout');
    expect(detail.run.errorSummary).toContain('timeout');
  });

  it('cancelled 只关闭显式目标 scope', async () => {
    const scope = makeScope();
    emitter.started(scope, 2);
    emitter.agentAdded(scope, { id: 'a1', name: 'A', role: 'a' });
    emitter.cancelled(scope);
    await writer.drain();

    const detail = repo.getRunDetail(createSwarmTraceStorageId(scope))!;
    expect(detail.run.status).toBe('cancelled');
    expect(detail.run.endedAt).not.toBeNull();
    expect(detail.events.map((event) => event.eventType)).toContain('swarm:cancelled');
  });

  it('两次 started 产生两个独立 run', async () => {
    const scope1 = makeScope();
    const scope2 = makeScope();
    emitter.started(scope1, 1);
    emitter.completed(scope1, { total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 10 });
    emitter.started(scope2, 2);
    emitter.completed(scope2, { total: 2, completed: 2, failed: 0, parallelPeak: 2, totalTime: 20 });
    await writer.drain();

    expect(repo.getRunDetail(createSwarmTraceStorageId(scope1))?.run.totalAgents).toBe(1);
    expect(repo.getRunDetail(createSwarmTraceStorageId(scope2))?.run.totalAgents).toBe(2);
  });

  it('listRuns 按 started_at desc 包含两次 run', async () => {
    const scope1 = makeScope();
    const scope2 = makeScope();
    emitter.started(scope1, 1);
    emitter.completed(scope1, { total: 1, completed: 1, failed: 0, parallelPeak: 1, totalTime: 10 });
    emitter.started(scope2, 2);
    emitter.completed(scope2, { total: 2, completed: 2, failed: 0, parallelPeak: 2, totalTime: 20 });
    await writer.drain();

    const list = repo.listRuns(10);
    expect(list.length).toBe(2);
    expect(list[0].startedAt).toBeGreaterThanOrEqual(list[1].startedAt);
  });

  it('persists the same logical runId in different sessions without collision', async () => {
    const base = Date.now();
    const scopeA: SwarmRunScope = { sessionId: 'sess-a', runId: 'same-run', treeId: 'tree-a' };
    const scopeB: SwarmRunScope = { sessionId: 'sess-b', runId: 'same-run', treeId: 'tree-b' };
    publishSwarm({
      type: 'swarm:started',
      ...scopeA,
      timestamp: base,
      data: { statistics: makeStats(1) },
    });
    publishSwarm({
      type: 'swarm:started',
      ...scopeB,
      timestamp: base + 1,
      data: { statistics: makeStats(1) },
    });
    publishSwarm({
      type: 'swarm:agent:added',
      ...scopeA,
      timestamp: base + 2,
      data: { agentId: 'a1', agentState: makeAgent('a1', 'running') },
    });
    publishSwarm({
      type: 'swarm:agent:added',
      ...scopeB,
      timestamp: base + 3,
      data: { agentId: 'b1', agentState: makeAgent('b1', 'running') },
    });
    publishSwarm({
      type: 'swarm:completed',
      ...scopeA,
      timestamp: base + 4,
      data: { statistics: makeStats(1, { completed: 1, pending: 0, parallelPeak: 1 }) },
    });
    publishSwarm({
      type: 'swarm:completed',
      ...scopeB,
      timestamp: base + 5,
      data: { statistics: makeStats(1, { completed: 1, pending: 0, parallelPeak: 1 }) },
    });

    await writer.drain();

    const storageA = createSwarmTraceStorageId(scopeA);
    const storageB = createSwarmTraceStorageId(scopeB);
    expect(storageA).not.toBe(storageB);
    const runA = repo.getRunDetail(storageA);
    const runB = repo.getRunDetail(storageB);
    expect(runA?.run.sessionId).toBe('sess-a');
    expect(runB?.run.sessionId).toBe('sess-b');
    expect(runA?.agents.map((agent) => agent.agentId)).toEqual(['a1']);
    expect(runB?.agents.map((agent) => agent.agentId)).toEqual(['b1']);
    expect(runA?.events.every((event) => event.runId === storageA)).toBe(true);
    expect(runB?.events.every((event) => event.runId === storageB)).toBe(true);
  });
});
