import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';

describe('workflow stall journal schema', () => {
  let db: BetterSqlite3.Database | undefined;

  afterEach(() => db?.close());

  it('creates the durable table/key and is idempotent on a second applySchema', () => {
    db = new Database(':memory:');
    const logger = {
      debug() {}, info() {}, warn() {}, error() {},
    } as unknown as Parameters<typeof applySchema>[1];
    applySchema(db, logger);
    const first = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_stall_notices'").get() as { sql: string };
    expect(first.sql).toContain('PRIMARY KEY (run_id, epoch)');
    expect(first.sql).not.toContain('FOREIGN KEY');
    expect(db.prepare('PRAGMA table_info(workflow_stall_notices)').all()).toHaveLength(3);

    applySchema(db, logger);
    const second = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_stall_notices'").get() as { sql: string };
    expect(second.sql).toEqual(first.sql);
  });
});
