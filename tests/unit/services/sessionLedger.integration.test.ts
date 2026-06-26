import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', () => ({
  loadBetterSqlite3: () => class MockDatabase {},
}));

import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { SwarmTraceRepository } from '../../../src/host/services/core/repositories/SwarmTraceRepository';
import type { Message } from '../../../src/shared/contract/message';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const SID = 'sess-replay';

/** 把真实 in-memory DB + 真实 repo 注入一个 DatabaseService 实例，跑真实 getSessionLedger 接线。 */
function wire(db: BetterSqlite3.Database): DatabaseService {
  const svc = new DatabaseService();
  Object.assign(svc as unknown as Record<string, unknown>, {
    db,
    sessionRepo: new SessionRepository(db),
    permissionDecisionRepo: new PermissionDecisionRepository(db),
    toolExecutionEventRepo: new ToolExecutionEventRepository(db),
    swarmTraceRepo: new SwarmTraceRepository(db),
  });
  return svc;
}

function seedSession(db: BetterSqlite3.Database): void {
  const sessionRepo = new SessionRepository(db);
  const permRepo = new PermissionDecisionRepository(db);
  const execRepo = new ToolExecutionEventRepository(db);
  const swarmRepo = new SwarmTraceRepository(db);

  // 会话主记录（messages 有 FK → sessions）
  db.prepare(`
    INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
    VALUES (?, 'replay', 'moonshot', 'kimi-k2.5', 0, 0)
  `).run(SID);

  // 成本（telemetry_sessions）
  db.prepare(`
    INSERT INTO telemetry_sessions
      (id, title, model_provider, model_name, working_directory, start_time,
       total_input_tokens, total_output_tokens, estimated_cost)
    VALUES (?, 'replay', 'moonshot', 'kimi-k2.5', '/tmp', 0, 1200, 340, 0.0875)
  `).run(SID);

  // 对话 lane（at=100 / 700）
  const msg = (id: string, role: Message['role'], content: string, ts: number): Message =>
    ({ id, role, content, timestamp: ts } as Message);
  sessionRepo.addMessage(SID, msg('m1', 'user', '帮我跑测试', 100), { skipTimestampUpdate: true });
  sessionRepo.addMessage(SID, msg('m2', 'assistant', '好的，开始', 700), { skipTimestampUpdate: true });

  // 任务 lane（at=200 / 650）
  sessionRepo.appendSessionTaskEvents([
    { sessionId: SID, taskId: '1', at: 200, kind: 'created', summary: '跑测试' },
    { sessionId: SID, taskId: '1', at: 650, kind: 'done', actor: 'agent-x' },
  ]);

  // 协同 lane（run 起 at=300、止 at=600；run 内事件 at=400）
  swarmRepo.startRun({ id: 'run-1', sessionId: SID, coordinator: 'orchestrator', startedAt: 300, totalAgents: 2, trigger: 'manual' });
  swarmRepo.appendEvent({ runId: 'run-1', seq: 1, timestamp: 400, eventType: 'agent_spawn', agentId: 'a1', level: 'info', title: 'spawn a1', summary: '', payload: null });
  swarmRepo.closeRun({ id: 'run-1', status: 'completed', endedAt: 600, completedCount: 2, failedCount: 0, parallelPeak: 2, totalTokensIn: 800, totalTokensOut: 200, totalToolCalls: 3, totalCostUsd: 0.0123, errorSummary: null, aggregation: null });

  // 决策 lane（at=450）
  permRepo.append({ sessionId: SID, toolName: 'Bash', summary: 'npm test', finalOutcome: 'allow', historyOutcome: 'auto-approve', reason: 'policy allow', durationMs: 4, recordedAt: 450 });

  // 执行 lane（begin at=500 / complete at=550）
  execRepo.appendBegin({ executionId: 'e1', sessionId: SID, toolName: 'Bash', summary: 'npm test', params: { cmd: 'npm test' }, recordedAt: 500 });
  execRepo.appendComplete({ executionId: 'e1', sessionId: SID, toolName: 'Bash', status: 'success', recordedAt: 550 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DatabaseService.getSessionLedger（第三期 3a · 一本账招牌证据）', () => {
  it('跨 6 lane 的真实会话 → 一个出口读回按时间排序的全链路时间线', () => {
    const db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    try {
      seedSession(db);
      const svc = wire(db);

      const ledger = svc.getSessionLedger(SID, 99_999);

      // 招牌：6 lane（成本走 header）全在，按时间升序
      expect(ledger.sessionId).toBe(SID);
      expect(ledger.generatedAt).toBe(99_999);
      const ats = ledger.entries.map((e) => e.at);
      expect(ats).toEqual([...ats].sort((a, b) => a - b));

      const lanes = new Set(ledger.entries.map((e) => e.lane));
      expect(lanes).toEqual(new Set(['message', 'task', 'swarm', 'decision', 'execution']));

      // 成本汇总对得上 telemetry_sessions
      expect(ledger.cost).toEqual({ estimatedCost: 0.0875, tokensIn: 1200, tokensOut: 340 });

      // 各 lane 条数：message 2、task 2、swarm 3(run起+止+1事件)、decision 1、execution 2
      expect(ledger.laneCounts).toMatchObject({ message: 2, task: 2, swarm: 3, decision: 1, execution: 2 });

      // 时间线首尾正确：第一条是 user 提问(at=100)，最末是 assistant 回复(at=700)
      expect(ledger.entries[0]).toMatchObject({ lane: 'message', kind: 'user' });
      expect(ledger.entries.at(-1)).toMatchObject({ lane: 'message', kind: 'assistant' });

      // 执行 lane 成对、决策可读回
      const exec = ledger.entries.filter((e) => e.lane === 'execution');
      expect(exec.map((e) => e.kind)).toEqual(['begin', 'complete:success']);
      expect(ledger.entries.find((e) => e.lane === 'decision')).toMatchObject({ kind: 'allow' });
    } finally {
      db.close();
    }
  });

  it('某 lane 空表时该 lane 缺席、其余正常', () => {
    const db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    try {
      // 只塞决策一条，其余 lane 空
      new PermissionDecisionRepository(db).append({
        sessionId: SID, toolName: 'Read', summary: null, finalOutcome: 'allow',
        historyOutcome: 'auto-approve', reason: 'r', durationMs: 1, recordedAt: 10,
      });
      const ledger = wire(db).getSessionLedger(SID, 1);
      expect(ledger.laneCounts).toMatchObject({ message: 0, task: 0, swarm: 0, decision: 1, execution: 0 });
      expect(ledger.entries).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('HIGH-1 回归：同一毫秒的多条决策在账本里按写入先后正序，不逆序', () => {
    const db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    try {
      const perm = new PermissionDecisionRepository(db);
      // 三条同毫秒(at=1000)决策，按 d1→d2→d3 顺序写入
      for (const name of ['d1', 'd2', 'd3']) {
        perm.append({
          sessionId: SID, toolName: name, summary: null, finalOutcome: 'allow',
          historyOutcome: 'auto-approve', reason: 'r', durationMs: 1, recordedAt: 1000,
        });
      }
      const ledger = wire(db).getSessionLedger(SID, 1);
      const tools = ledger.entries.filter((e) => e.lane === 'decision').map((e) => e.summary.split(':')[0]);
      expect(tools).toEqual(['d1', 'd2', 'd3']); // 正序，不是 d3,d2,d1
    } finally {
      db.close();
    }
  });

  it('MED-1 回归：某 session 的 swarm run 即使不在全局最近 N 内也不被漏掉', () => {
    const db = new Database(':memory:');
    applySchema(db, createLogger() as never);
    try {
      db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES (?, 't', 'p', 'm', 0, 0)`).run(SID);
      const swarmRepo = new SwarmTraceRepository(db);
      // 本 session 的 run 时间最早(startedAt=1)
      swarmRepo.startRun({ id: 'mine', sessionId: SID, coordinator: 'orchestrator', startedAt: 1, totalAgents: 1, trigger: 'manual' });
      // 其它 session 灌 60 条更晚的 run（把全局最近 50 挤满）
      for (let i = 0; i < 60; i++) {
        swarmRepo.startRun({ id: `other-${i}`, sessionId: 'other-sess', coordinator: 'orchestrator', startedAt: 1000 + i, totalAgents: 1, trigger: 'manual' });
      }
      const ledger = wire(db).getSessionLedger(SID, 1);
      const swarm = ledger.entries.filter((e) => e.lane === 'swarm');
      expect(swarm).toHaveLength(1); // 本 session 的 run 仍在（按 session 直查，无全局截断）
      expect(swarm[0].refId).toBe('mine');
    } finally {
      db.close();
    }
  });

  it('DB 不可用时返回空账不抛（fail-safe）', () => {
    const svc = new DatabaseService(); // 未注入 db
    expect(() => svc.getSessionLedger(SID, 1)).not.toThrow();
    const ledger = svc.getSessionLedger(SID, 1);
    expect(ledger.entries).toEqual([]);
    expect(ledger.cost.estimatedCost).toBe(0);
  });
});
