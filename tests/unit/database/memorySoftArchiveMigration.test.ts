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

describe('memories soft-archive migration', () => {
  it('adds status/deprecated_by and backfills legacy metadata archives without deleting content', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        source TEXT NOT NULL,
        project_path TEXT,
        session_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        metadata TEXT DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER
      );
      INSERT INTO memories (
        id, type, category, content, source, confidence, metadata, access_count, created_at, updated_at
      ) VALUES (
        'legacy-archived', 'project_knowledge', 'context', 'original evidence', 'user_defined', 1,
        '{"memoryEntry":{"status":"archived","deprecatedBy":"mem-replacement"}}', 0, 1, 1
      );
    `);

    applySchema(db, logger);

    const migrated = db.prepare('SELECT status, deprecated_by, content FROM memories WHERE id = ?')
      .get('legacy-archived') as { status: string; deprecated_by: string | null; content: string };
    expect(migrated).toEqual({ status: 'archived', deprecated_by: 'mem-replacement', content: 'original evidence' });

    db.prepare('UPDATE memories SET status = ?, deprecated_by = NULL WHERE id = ?')
      .run('active', 'legacy-archived');
    applySchema(db, logger);

    const restored = db.prepare('SELECT status, deprecated_by, content FROM memories WHERE id = ?')
      .get('legacy-archived') as { status: string; deprecated_by: string | null; content: string };
    expect(restored).toEqual({ status: 'active', deprecated_by: null, content: 'original evidence' });
    db.close();
  });
});
