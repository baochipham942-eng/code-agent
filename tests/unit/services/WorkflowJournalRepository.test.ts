// ============================================================================
// WorkflowJournalRepository Tests (P4-B)
//
// resumable 重放的持久化地基：run 级元数据（workflow_runs）+ 逐 agent() 调用结果缓存
// （workflow_run_calls，按 run_id + call_index 复合主键）。用真实 better-sqlite3 in-memory
// 覆盖：startRun/finishRun 生命周期、recordCall 幂等、loadRun 拼装、result 类型保真（string
// vs object 经 JSON round-trip 不串）、deleteRun 级联、clearAll。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { WorkflowJournalRepository } from '../../../src/main/services/core/repositories/WorkflowJournalRepository';

// 与 schema.ts 的 workflow_runs / workflow_run_calls 逐字一致（测试自带 schema，解耦全量 applySchema）。
function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY,
      script_hash TEXT NOT NULL,
      goal TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error TEXT,
      working_directory TEXT
    )
  `);
  db.exec(`
    CREATE TABLE workflow_run_calls (
      run_id TEXT NOT NULL,
      call_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      label TEXT,
      result_json TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, call_index),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id) ON DELETE CASCADE
    )
  `);
}

describe('WorkflowJournalRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: WorkflowJournalRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    repo = new WorkflowJournalRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('startRun then getRun returns a running record', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc123', goal: '查点东西', sessionId: 's1', startedAt: 1000 });
    const run = repo.getRun('wf-1');
    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      runId: 'wf-1',
      scriptHash: 'abc123',
      goal: '查点东西',
      sessionId: 's1',
      status: 'running',
      startedAt: 1000,
      finishedAt: null,
      tokensSpent: 0,
    });
  });

  it('startRun persists workingDir and getRun reads it back', () => {
    repo.startRun({ runId: 'wf-wd', scriptHash: 'abc', startedAt: 1000, workingDir: '/some/repo' });
    const run = repo.getRun('wf-wd');
    expect(run?.workingDir).toBe('/some/repo');
  });

  it('startRun without workingDir leaves it null', () => {
    repo.startRun({ runId: 'wf-no-wd', scriptHash: 'abc', startedAt: 1000 });
    const run = repo.getRun('wf-no-wd');
    expect(run?.workingDir).toBeNull();
  });

  it('finishRun updates status / finishedAt / tokensSpent / result', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    repo.finishRun({ runId: 'wf-1', status: 'completed', finishedAt: 2000, tokensSpent: 4242, result: { report: 'ok' } });
    const run = repo.getRun('wf-1');
    expect(run?.status).toBe('completed');
    expect(run?.finishedAt).toBe(2000);
    expect(run?.tokensSpent).toBe(4242);
    expect(run?.result).toEqual({ report: 'ok' });
  });

  it('finishRun with failure stores error', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    repo.finishRun({ runId: 'wf-1', status: 'failed', finishedAt: 1500, tokensSpent: 10, error: 'boom' });
    const run = repo.getRun('wf-1');
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('boom');
  });

  it('recordCall + loadRun assembles calls indexed by call_index', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    repo.recordCall({ runId: 'wf-1', callIndex: 1, contentHash: 'h1', result: 'first', tokensUsed: 11, label: 'a', ts: 1100 });
    repo.recordCall({ runId: 'wf-1', callIndex: 2, contentHash: 'h2', result: { v: 2 }, tokensUsed: 22, ts: 1200 });

    const loaded = repo.loadRun('wf-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.run.runId).toBe('wf-1');
    expect(loaded!.calls.size).toBe(2);
    expect(loaded!.calls.get(1)).toMatchObject({ callIndex: 1, contentHash: 'h1', result: 'first', tokensUsed: 11 });
    expect(loaded!.calls.get(2)).toMatchObject({ callIndex: 2, contentHash: 'h2', result: { v: 2 }, tokensUsed: 22 });
  });

  it('result round-trip is type-faithful (string stays string, object stays object)', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    // 一个内容恰好长得像 JSON 的字符串：round-trip 后仍须是 string，不能被解析成对象。
    repo.recordCall({ runId: 'wf-1', callIndex: 1, contentHash: 'h', result: '{"a":1}', tokensUsed: 0, ts: 1 });
    repo.recordCall({ runId: 'wf-1', callIndex: 2, contentHash: 'h', result: { a: 1 }, tokensUsed: 0, ts: 2 });
    const loaded = repo.loadRun('wf-1')!;
    expect(typeof loaded.calls.get(1)!.result).toBe('string');
    expect(loaded.calls.get(1)!.result).toBe('{"a":1}');
    expect(typeof loaded.calls.get(2)!.result).toBe('object');
    expect(loaded.calls.get(2)!.result).toEqual({ a: 1 });
  });

  it('recordCall is idempotent on (run_id, call_index) — re-record replaces', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    repo.recordCall({ runId: 'wf-1', callIndex: 1, contentHash: 'h1', result: 'old', tokensUsed: 5, ts: 1 });
    repo.recordCall({ runId: 'wf-1', callIndex: 1, contentHash: 'h2', result: 'new', tokensUsed: 9, ts: 2 });
    const loaded = repo.loadRun('wf-1')!;
    expect(loaded.calls.size).toBe(1);
    expect(loaded.calls.get(1)).toMatchObject({ contentHash: 'h2', result: 'new', tokensUsed: 9 });
  });

  // ── Codex round1 HIGH#2：run result（脚本 return 任意值）round-trip 必须类型保真，不得压扁 ──
  it('run result round-trip is faithful for non-string/non-object types (array / number / boolean)', () => {
    repo.startRun({ runId: 'r-arr', scriptHash: 'h', startedAt: 1 });
    repo.finishRun({ runId: 'r-arr', status: 'completed', finishedAt: 2, tokensSpent: 0, result: [1, 2, 3] });
    expect(repo.getRun('r-arr')?.result).toEqual([1, 2, 3]);

    repo.startRun({ runId: 'r-num', scriptHash: 'h', startedAt: 1 });
    repo.finishRun({ runId: 'r-num', status: 'completed', finishedAt: 2, tokensSpent: 0, result: 42 });
    expect(repo.getRun('r-num')?.result).toBe(42);

    repo.startRun({ runId: 'r-bool', scriptHash: 'h', startedAt: 1 });
    repo.finishRun({ runId: 'r-bool', status: 'completed', finishedAt: 2, tokensSpent: 0, result: true });
    expect(repo.getRun('r-bool')?.result).toBe(true);

    repo.startRun({ runId: 'r-obj', scriptHash: 'h', startedAt: 1 });
    repo.finishRun({ runId: 'r-obj', status: 'completed', finishedAt: 2, tokensSpent: 0, result: { a: 1 } });
    expect(repo.getRun('r-obj')?.result).toEqual({ a: 1 });

    repo.startRun({ runId: 'r-str', scriptHash: 'h', startedAt: 1 });
    repo.finishRun({ runId: 'r-str', status: 'completed', finishedAt: 2, tokensSpent: 0, result: 'hi' });
    expect(repo.getRun('r-str')?.result).toBe('hi');
  });

  it('loadRun / getRun return null for unknown run', () => {
    expect(repo.loadRun('nope')).toBeNull();
    expect(repo.getRun('nope')).toBeNull();
  });

  it('deleteRun cascades to calls', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    repo.recordCall({ runId: 'wf-1', callIndex: 1, contentHash: 'h', result: 'x', tokensUsed: 0, ts: 1 });
    expect(repo.deleteRun('wf-1')).toBe(true);
    expect(repo.getRun('wf-1')).toBeNull();
    // 级联：calls 也清空
    const remaining = db.prepare('SELECT COUNT(*) as c FROM workflow_run_calls WHERE run_id = ?').get('wf-1') as { c: number };
    expect(remaining.c).toBe(0);
    expect(repo.deleteRun('wf-1')).toBe(false);
  });

  it('clearAll wipes both tables', () => {
    repo.startRun({ runId: 'wf-1', scriptHash: 'abc', startedAt: 1000 });
    repo.recordCall({ runId: 'wf-1', callIndex: 1, contentHash: 'h', result: 'x', tokensUsed: 0, ts: 1 });
    repo.clearAll();
    expect(repo.getRun('wf-1')).toBeNull();
    const c = db.prepare('SELECT COUNT(*) as c FROM workflow_run_calls').get() as { c: number };
    expect(c.c).toBe(0);
  });
});
