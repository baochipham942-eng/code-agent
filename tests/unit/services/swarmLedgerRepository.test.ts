import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { SwarmLedgerRepository } from '../../../src/host/services/core/repositories/SwarmLedgerRepository';
import type { SwarmLedgerAppendInput } from '../../../src/shared/contract/swarmLedger';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
function freshDb() {
  const db = new Database(':memory:');
  applySchema(db, createLogger() as never);
  return db;
}

const started: SwarmLedgerAppendInput = {
  runId: 'run-1', sessionId: 's1', seq: 0, kind: 'run_started', agentId: null,
  payload: { coordinator: 'hybrid', startedAt: 100, totalAgents: 2, trigger: 'llm-spawn' },
  recordedAt: 100,
};
const agentSnap = (agentId: string, seq: number, tokensIn: number): SwarmLedgerAppendInput => ({
  runId: 'run-1', sessionId: 's1', seq, kind: 'agent_snapshot', agentId,
  payload: { agentId, name: agentId, role: 'worker', status: 'completed', startTime: 110, endTime: 200, durationMs: 90, tokensIn, tokensOut: 50, toolCalls: 3, costUsd: 0.01, error: null, failureCategory: null, filesChanged: [] },
  recordedAt: 110 + seq,
});

describe('SwarmLedgerRepository（3b 协同事件账本 · append-only 真理源）', () => {
  it('schema 建出 swarm_run_ledger 表与索引', () => {
    const db = freshDb();
    try {
      const cols = db.prepare('PRAGMA table_info(swarm_run_ledger)').all().map((r) => (r as { name: string }).name);
      expect(cols).toEqual(expect.arrayContaining(['id', 'run_id', 'session_id', 'seq', 'event_kind', 'agent_id', 'payload_json', 'recorded_at']));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='swarm_run_ledger'").all().map((r) => (r as { name: string }).name);
      expect(idx).toEqual(expect.arrayContaining(['idx_swarm_run_ledger_run', 'idx_swarm_run_ledger_session']));
    } finally { db.close(); }
  });

  it('append → getByRun 按 seq 升序取回，payload round-trip', () => {
    const db = freshDb();
    try {
      const repo = new SwarmLedgerRepository(db);
      repo.append(agentSnap('a2', 2, 200));
      repo.append(started);
      repo.append(agentSnap('a1', 1, 100));
      const events = repo.getByRun('run-1');
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]); // seq 升序，不受插入序影响
      expect(events[0].kind).toBe('run_started');
      expect(events[0].payload).toMatchObject({ coordinator: 'hybrid', totalAgents: 2 });
      expect(events[2].payload).toMatchObject({ agentId: 'a2', tokensIn: 200 });
    } finally { db.close(); }
  });

  it('多 run 隔离 + count 递增', () => {
    const db = freshDb();
    try {
      const repo = new SwarmLedgerRepository(db);
      repo.append(started);
      repo.append({ ...started, runId: 'run-2', sessionId: 's2' });
      expect(repo.count()).toBe(2);
      expect(repo.getByRun('run-1')).toHaveLength(1);
      expect(repo.getByRun('run-2')).toHaveLength(1);
    } finally { db.close(); }
  });

  it('listRunIds 按 session 过滤、按最近倒序', () => {
    const db = freshDb();
    try {
      const repo = new SwarmLedgerRepository(db);
      repo.append({ ...started, runId: 'run-old', recordedAt: 10 });
      repo.append({ ...started, runId: 'run-new', recordedAt: 999 });
      repo.append({ ...started, runId: 'run-other', sessionId: 'sX', recordedAt: 500 });
      expect(repo.listRunIds('s1')).toEqual(['run-new', 'run-old']); // 倒序，且只 s1
      expect(repo.listRunIds()).toContain('run-other'); // 不过滤含全部
    } finally { db.close(); }
  });

  it('append-only 不变量：仓储不暴露任何 update/delete 方法', () => {
    const db = freshDb();
    try {
      const repo = new SwarmLedgerRepository(db) as unknown as Record<string, unknown>;
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter((m) => m !== 'constructor');
      expect(methods.filter((m) => /update|delete|remove|clear|drop/i.test(m))).toEqual([]);
      expect(methods.sort()).toEqual(['append', 'count', 'getByRun', 'listRunIds']);
    } finally { db.close(); }
  });
});
