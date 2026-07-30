import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

describe('sessions is_archived migration', () => {
  it('adds the missing column to an existing database and remains idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        working_directory TEXT,
        project_id TEXT,
        session_type TEXT NOT NULL DEFAULT 'chat',
        origin TEXT,
        metadata TEXT,
        parent_session_id TEXT,
        source_run_id TEXT,
        agent_engine TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'auto',
        suppressed_memory_entry_ids TEXT NOT NULL DEFAULT '[]',
        read_only INTEGER NOT NULL DEFAULT 0,
        retry_of_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        workbench_provenance TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER
      );
    `);

    applySchema(db, logger);
    applySchema(db, logger);

    const column = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((item) => item.name === 'is_archived');
    expect(column).toMatchObject({ name: 'is_archived', notnull: 1, dflt_value: '0' });
    db.close();
  });
});
