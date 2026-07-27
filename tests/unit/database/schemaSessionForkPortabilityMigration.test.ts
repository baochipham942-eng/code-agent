import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySessionForkPortabilitySchema } from '../../../src/host/services/core/database/schemaSessionForkPortability';

describe('session fork portability schema', () => {
  it('is idempotent and creates durable immutable exports plus restart-safe sync/import ledgers', () => {
    const db = new Database(':memory:');

    applySessionForkPortabilitySchema(db);
    applySessionForkPortabilitySchema(db);

    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'session_fork_portability_%'
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      'session_fork_portability_exports',
      'session_fork_portability_imports',
      'session_fork_portability_sync',
    ]);

    db.prepare(`
      INSERT INTO session_fork_portability_exports (
        export_id, owner_scope_id, project_id, root_session_id, mode,
        payload_digest, envelope_json, created_at
      ) VALUES ('export-1', 'owner-1', 'project-1', 'root-1', 'subtree',
                'sha256:digest', '{}', 1)
    `).run();
    expect(() => db.prepare(`
      UPDATE session_fork_portability_exports
      SET envelope_json = '{"tampered":true}'
      WHERE export_id = 'export-1'
    `).run()).toThrow(/immutable/);
    expect(() => db.prepare(`
      DELETE FROM session_fork_portability_exports WHERE export_id = 'export-1'
    `).run()).toThrow(/immutable/);

    db.close();
  });
});
