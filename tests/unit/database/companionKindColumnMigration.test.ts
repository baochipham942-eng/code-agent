// companion_decisions.kind ALTER 此前裸 catch 吞掉所有错误。
// 锁住：只吞 better-sqlite3「duplicate column name」，其余（锁/损坏/表缺失）上抛。

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyCompanionSchema } from '../../../src/host/services/core/database/migrations/companion';

const LEGACY_DECISIONS_DDL = `
  CREATE TABLE companion_decisions (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    resolved_by TEXT,
    operation_digest TEXT
  )
`;

function columnNames(db: BetterSqlite3.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

describe('companion_decisions.kind column migration', () => {
  let db: BetterSqlite3.Database | undefined;

  afterEach(() => db?.close());

  it('adds kind to a legacy companion_decisions table that lacks the column', () => {
    db = new Database(':memory:');
    db.exec(LEGACY_DECISIONS_DDL);
    db.prepare(`
      INSERT INTO companion_decisions (request_id, session_id, revision, status)
      VALUES ('req-legacy', 'session-1', 1, 'pending')
    `).run();
    expect(columnNames(db, 'companion_decisions')).not.toContain('kind');

    applyCompanionSchema(db);

    expect(columnNames(db, 'companion_decisions')).toContain('kind');
    expect(
      db.prepare(`SELECT kind FROM companion_decisions WHERE request_id = 'req-legacy'`).get(),
    ).toEqual({ kind: 'approval' });
  });

  it('is idempotent when companion_decisions already has kind', () => {
    db = new Database(':memory:');
    applyCompanionSchema(db);
    expect(columnNames(db, 'companion_decisions')).toContain('kind');

    expect(() => applyCompanionSchema(db!)).not.toThrow();
    expect(columnNames(db, 'companion_decisions')).toContain('kind');
  });

  it('rethrows ALTER failures that are not duplicate-column', () => {
    db = new Database(':memory:');
    const originalExec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (sql.includes('ALTER TABLE companion_decisions ADD COLUMN kind')) {
        return originalExec(
          `ALTER TABLE __companion_kind_migrate_missing ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval'`,
        );
      }
      return originalExec(sql);
    }) as typeof db.exec;

    expect(() => applyCompanionSchema(db!)).toThrow(/no such table/i);
  });
});
