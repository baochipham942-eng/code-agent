import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { UsageLedgerRepository } from '../../../../src/host/services/core/repositories/UsageLedgerRepository';

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function freshDb() {
  const db = new Database(':memory:');
  applySchema(db, createLogger() as never);
  return db;
}

describe('UsageLedgerRepository（A7 · per-request 用量账本）', () => {
  it('schema 建出 usage_ledger 表与索引', () => {
    const db = freshDb();
    try {
      const cols = db.prepare('PRAGMA table_info(usage_ledger)').all().map((r) => (r as { name: string }).name);
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'session_id', 'model', 'provider', 'input_tokens', 'output_tokens',
        'cache_read_tokens', 'cache_creation_tokens', 'recorded_at',
      ]));
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_ledger'").all().map((r) => (r as { name: string }).name);
      expect(idx).toEqual(expect.arrayContaining(['idx_usage_ledger_session', 'idx_usage_ledger_recorded']));
    } finally {
      db.close();
    }
  });

  it('append → getBySession 取回，字段 round-trip 还原', () => {
    const db = freshDb();
    try {
      const repo = new UsageLedgerRepository(db);
      repo.append({
        sessionId: 's1', model: 'deepseek-chat', provider: 'deepseek',
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 50,
        recordedAt: 1000,
      });
      const rows = repo.getBySession('s1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: 's1', model: 'deepseek-chat', provider: 'deepseek',
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 50,
        recordedAt: 1000,
      });
    } finally {
      db.close();
    }
  });

  it('sessionId 缺省时仍可落账（后台 overhead 记账等无会话场景）', () => {
    const db = freshDb();
    try {
      const repo = new UsageLedgerRepository(db);
      repo.append({ model: 'kimi-k2.5', provider: 'moonshot', inputTokens: 10, outputTokens: 5, recordedAt: 1 });
      expect(repo.count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('getBySession 只返回该会话的记录，按时间升序', () => {
    const db = freshDb();
    try {
      const repo = new UsageLedgerRepository(db);
      repo.append({ sessionId: 'a', model: 'm', provider: 'p', inputTokens: 1, outputTokens: 1, recordedAt: 20 });
      repo.append({ sessionId: 'b', model: 'm', provider: 'p', inputTokens: 1, outputTokens: 1, recordedAt: 10 });
      repo.append({ sessionId: 'a', model: 'm', provider: 'p', inputTokens: 2, outputTokens: 2, recordedAt: 10 });
      const rowsA = repo.getBySession('a');
      expect(rowsA.map((r) => r.recordedAt)).toEqual([10, 20]);
    } finally {
      db.close();
    }
  });

  it('count 随记账追加递增', () => {
    const db = freshDb();
    try {
      const repo = new UsageLedgerRepository(db);
      expect(repo.count()).toBe(0);
      repo.append({ model: 'm', provider: 'p', inputTokens: 1, outputTokens: 1, recordedAt: 1 });
      expect(repo.count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('append-only 不变量：仓储不暴露任何 update / delete 方法', () => {
    const repo = new UsageLedgerRepository(freshDb());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    const mutating = methods.filter((m) => /update|delete|remove|drop|clear|truncate/i.test(m));
    expect(mutating).toEqual([]);
  });
});
