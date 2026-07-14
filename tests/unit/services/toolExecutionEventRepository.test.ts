import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function freshDb() {
  const db = new Database(':memory:');
  applySchema(db, createLogger() as never);
  return db;
}

describe('ToolExecutionEventRepository（事件账本第二期 · 执行生命周期）', () => {
  it('schema 建出 tool_execution_events 表与索引', () => {
    const db = freshDb();
    try {
      const cols = db.prepare('PRAGMA table_info(tool_execution_events)').all().map((r) => (r as { name: string }).name);
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'execution_id', 'session_id', 'tool_name', 'summary', 'params_json', 'phase', 'status', 'error', 'recorded_at',
      ]));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_execution_events'").all().map((r) => (r as { name: string }).name);
      expect(idx).toEqual(expect.arrayContaining([
        'idx_tool_execution_events_exec_phase',
        'idx_tool_execution_events_session',
        'idx_tool_execution_events_phase',
      ]));
      // 单列 execution_id 索引已被 (execution_id, phase) 复合索引取代（前缀覆盖）
      expect(idx).not.toContain('idx_tool_execution_events_exec');
    } finally {
      db.close();
    }
  });

  it('appendBegin → getOpenExecutions 取回，params round-trip 还原', () => {
    const db = freshDb();
    try {
      const repo = new ToolExecutionEventRepository(db);
      repo.appendBegin({
        executionId: 'exec-1', sessionId: 's1', toolName: 'Bash',
        summary: 'npm run build', params: { command: 'npm run build', cwd: '/tmp' }, recordedAt: 1000,
      });
      const open = repo.getOpenExecutions();
      expect(open).toHaveLength(1);
      expect(open[0].executionId).toBe('exec-1');
      expect(open[0].sessionId).toBe('s1');
      expect(open[0].toolName).toBe('Bash');
      expect(open[0].params).toEqual({ command: 'npm run build', cwd: '/tmp' });
      expect(open[0].startedAt).toBe(1000);
    } finally {
      db.close();
    }
  });

  it('append complete 后该执行不再 open（begin/complete 闭合）', () => {
    const db = freshDb();
    try {
      const repo = new ToolExecutionEventRepository(db);
      repo.appendBegin({ executionId: 'exec-2', toolName: 'Write', summary: 'a.ts', params: { file_path: 'a.ts' }, recordedAt: 2000 });
      expect(repo.getOpenExecutions()).toHaveLength(1);
      repo.appendComplete({ executionId: 'exec-2', toolName: 'Write', status: 'success', recordedAt: 2050 });
      expect(repo.getOpenExecutions()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('多 execution 并存，只浮现未闭合的那几条', () => {
    const db = freshDb();
    try {
      const repo = new ToolExecutionEventRepository(db);
      // 已完成的
      repo.appendBegin({ executionId: 'done-1', toolName: 'Read', summary: 'r', params: {}, recordedAt: 10 });
      repo.appendComplete({ executionId: 'done-1', toolName: 'Read', status: 'success', recordedAt: 11 });
      // 出错完成的
      repo.appendBegin({ executionId: 'err-1', toolName: 'Bash', summary: 'b', params: {}, recordedAt: 12 });
      repo.appendComplete({ executionId: 'err-1', toolName: 'Bash', status: 'error', error: 'boom', recordedAt: 13 });
      // 仍在飞的两条（崩溃现场）
      repo.appendBegin({ executionId: 'live-1', toolName: 'Edit', summary: 'e1', params: { p: 1 }, recordedAt: 14 });
      repo.appendBegin({ executionId: 'live-2', toolName: 'Edit', summary: 'e2', params: { p: 2 }, recordedAt: 15 });

      const open = repo.getOpenExecutions();
      const ids = open.map((o) => o.executionId).sort();
      expect(ids).toEqual(['live-1', 'live-2']);
    } finally {
      db.close();
    }
  });

  it('complete 携带 error 时可从 getRecent 读回 status/error', () => {
    const db = freshDb();
    try {
      const repo = new ToolExecutionEventRepository(db);
      repo.appendBegin({ executionId: 'x', toolName: 'Bash', summary: 's', params: {}, recordedAt: 100 });
      repo.appendComplete({ executionId: 'x', toolName: 'Bash', status: 'error', error: 'failed hard', recordedAt: 101 });
      const recent = repo.getRecent(10);
      const completeRow = recent.find((r) => r.phase === 'complete');
      expect(completeRow?.status).toBe('error');
      expect(completeRow?.error).toBe('failed hard');
    } finally {
      db.close();
    }
  });

  it('count 随事件追加递增', () => {
    const db = freshDb();
    try {
      const repo = new ToolExecutionEventRepository(db);
      expect(repo.count()).toBe(0);
      repo.appendBegin({ executionId: 'c1', toolName: 'Read', summary: 's', params: {}, recordedAt: 1 });
      expect(repo.count()).toBe(1);
      repo.appendComplete({ executionId: 'c1', toolName: 'Read', status: 'success', recordedAt: 2 });
      expect(repo.count()).toBe(2);
    } finally {
      db.close();
    }
  });

  it('append-only 不变量：仓储不暴露任何 update / delete 方法', () => {
    const repo = new ToolExecutionEventRepository(freshDb());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    const mutating = methods.filter((m) => /update|delete|remove|drop|clear|truncate/i.test(m));
    expect(mutating).toEqual([]);
  });
});
