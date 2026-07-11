import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { DURABLE_RUN_KILL_RESTART_SCENARIOS } from '../../../fixtures/durableRunKillRestart';

function createLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  applySchema(db, logger as never);
  applySessionsMigrations(db, logger as never);
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
}

describe('Durable Run kill/restart failure gold', () => {
  it.each(DURABLE_RUN_KILL_RESTART_SCENARIOS)(
    '$killPoint lacks the identity needed for deterministic resume',
    ({ legacyTable, missingEvidence, expectedRecovery }) => {
    const db = createLegacyDb();
    const existing = columns(db, legacyTable);

    for (const field of missingEvidence) {
      expect(existing, `${legacyTable} unexpectedly gained ${field}; update the gold and wire recovery`).not.toContain(field);
    }
    expect(expectedRecovery.length).toBeGreaterThan(20);
    db.close();
    },
  );

  it('terminal writeback is session-scoped and cannot atomically prove a run terminal event', () => {
    const db = createLegacyDb();
    const sessionColumns = columns(db, 'sessions');
    const sessionEventColumns = columns(db, 'session_events');

    expect(sessionColumns).toContain('status');
    expect(sessionColumns).not.toContain('active_run_id');
    expect(sessionEventColumns).not.toEqual(expect.arrayContaining(['run_id', 'seq', 'attempt']));
    db.close();
  });
});
