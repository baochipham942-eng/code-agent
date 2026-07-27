import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

describe('Fork/Rewind backward-compatible schema migration', () => {
  let db: BetterSqlite3.Database | undefined;

  afterEach(() => db?.close());

  it('preserves legacy rewind rows while adding idempotency and lineage tables', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);

    db.exec('DROP TABLE session_fork_message_map');
    db.exec('DROP TABLE session_forks');
    db.exec('ALTER TABLE session_rewinds RENAME TO session_rewinds_new_shape');
    db.exec(`
      CREATE TABLE session_rewinds (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        anchor_message_id TEXT NOT NULL,
        anchor_prompt TEXT NOT NULL,
        anchor_timestamp INTEGER NOT NULL,
        checkpoint_message_id TEXT,
        hidden_message_count INTEGER NOT NULL DEFAULT 0,
        hidden_message_ids TEXT NOT NULL DEFAULT '[]',
        files_restored INTEGER NOT NULL DEFAULT 0,
        files_deleted INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO session_rewinds (
        id, session_id, anchor_message_id, anchor_prompt, anchor_timestamp,
        hidden_message_count, hidden_message_ids, created_at
      ) VALUES ('legacy-rewind', 'legacy-session', 'u1', 'prompt', 10, 2, '["u1","a1"]', 20)
    `);
    db.exec('DROP TABLE session_rewinds_new_shape');

    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyIndexes(db);

    expect(db.prepare(`
      SELECT id, idempotency_key, request_digest, status, restored_at
      FROM session_rewinds WHERE id = 'legacy-rewind'
    `).get()).toEqual({
      id: 'legacy-rewind',
      idempotency_key: null,
      request_digest: null,
      status: 'completed',
      restored_at: null,
    });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'session_forks',
        'session_fork_message_map',
        'session_fork_anchor_evidence',
        'session_fork_workspace_intents',
        'session_fork_workspace_sagas'
      )
      ORDER BY name
    `).all()).toEqual([
      { name: 'session_fork_anchor_evidence' },
      { name: 'session_fork_message_map' },
      { name: 'session_fork_workspace_intents' },
      { name: 'session_fork_workspace_sagas' },
      { name: 'session_forks' },
    ]);
  });
});
