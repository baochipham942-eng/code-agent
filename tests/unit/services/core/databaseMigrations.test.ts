import { applyTestTelemetrySchema } from '../../../utils/telemetrySchema';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applyTelemetryTurnsMigrations } from '../../../../src/host/services/core/database/migrations';
import type { Logger } from '../../../../src/host/services/core/database/schemaHelpers';

function createLogger() {
  // Logger = ReturnType<typeof createLogger>（infra/logger）带私有字段/方法，plain object 无法结构满足，需 cast。
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('database migrations', () => {
  it('treats already-dropped telemetry generation_id column as idempotent', () => {
    const db = new Database(':memory:');
    const logger = createLogger();

    applyTestTelemetrySchema(db);

    applyTelemetryTurnsMigrations(db, logger);

    expect(logger.warn).not.toHaveBeenCalledWith(
      '[DB] Migration unexpected error:',
      expect.stringContaining('generation_id'),
    );
    db.close();
  });

  it('adds prompt-cache usage columns to telemetry model calls', () => {
    const db = new Database(':memory:');
    const logger = createLogger();
    applyTestTelemetrySchema(db);
    // Recreate the pre-migration state using the production table shape.
    db.exec('ALTER TABLE telemetry_model_calls DROP COLUMN cache_read_tokens');
    db.exec('ALTER TABLE telemetry_model_calls DROP COLUMN cache_creation_tokens');

    applyTelemetryTurnsMigrations(db, logger);

    const columns = db.prepare('PRAGMA table_info(telemetry_model_calls)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'cache_read_tokens',
      'cache_creation_tokens',
    ]));
    db.close();
  });
});
