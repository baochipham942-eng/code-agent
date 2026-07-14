// ============================================================================
// applySchema — stale-FTS 清理的一次性门（user_version gate）
// ============================================================================
// 背景：schema.ts 里清理 meta/loop 消息 stale FTS 行的 DELETE 子查询要全表扫
// messages.content（双 LIKE），1.28GB 生产库实测 ~4s，曾是启动 health-ready 的
// 最大单项。改为 user_version < 1 时才跑、跑完置 1。本文件验证：
//   - 全新库跑完 applySchema 后 user_version = 1
//   - user_version = 0（旧库升级）时 stale 行会被清理
//   - user_version = 1 时 DELETE 被跳过（stale 行存活 = 门真的生效）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof applySchema>[1];

function insertMetaMessageWithStaleFtsRow(db: BetterSqlite3.Database, id: string): void {
  // is_meta=1 的消息：triggers 会过滤掉，FTS 行手工插入模拟旧版 triggers 留下的脏行
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
     VALUES ('s1', 't', 'p', 'm', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, timestamp, is_meta)
     VALUES (?, 's1', 'user', 'meta content', 1, 1)`,
  ).run(id);
  db.prepare(
    `INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
     VALUES (?, 's1', 'user', 'meta content', 1)`,
  ).run(id);
}

function ftsRowCount(db: BetterSqlite3.Database, id: string): number {
  return (db.prepare('SELECT COUNT(*) as c FROM session_messages_fts WHERE message_id = ?').get(id) as { c: number }).c;
}

describe('applySchema stale-FTS cleanup gate', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('全新库 applySchema 后 user_version 置 1', () => {
    applySchema(db, noopLogger);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('user_version=0（旧库）时清理 stale FTS 行并置 1', () => {
    applySchema(db, noopLogger);
    db.pragma('user_version = 0');
    insertMetaMessageWithStaleFtsRow(db, 'm-stale');

    applySchema(db, noopLogger);

    expect(ftsRowCount(db, 'm-stale')).toBe(0);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('user_version=1 时跳过清理（stale 行存活，证明门生效）', () => {
    applySchema(db, noopLogger);
    insertMetaMessageWithStaleFtsRow(db, 'm-stale');

    applySchema(db, noopLogger);

    expect(ftsRowCount(db, 'm-stale')).toBe(1);
  });
});
