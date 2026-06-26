import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applyTelemetryTurnsMigrations } from '../../../../src/host/services/core/database/migrations';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('database migrations', () => {
  it('treats already-dropped telemetry generation_id column as idempotent', () => {
    const db = new Database(':memory:');
    const logger = createLogger();

    db.exec(`
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      )
    `);

    applyTelemetryTurnsMigrations(db, logger);

    expect(logger.warn).not.toHaveBeenCalledWith(
      '[DB] Migration unexpected error:',
      expect.stringContaining('generation_id'),
    );
    db.close();
  });
});
