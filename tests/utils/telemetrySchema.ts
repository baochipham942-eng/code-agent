import type Database from 'better-sqlite3';
import { applyTelemetrySchema } from '../../src/host/services/core/database/schemaTelemetry';
import { applyTelemetryTurnsMigrations } from '../../src/host/services/core/database/migrations';
import { createLogger } from '../../src/host/services/infra/logger';

/** Current production schema, including migrations and constraints. */
export function applyTestTelemetrySchema(db: Database.Database): void {
  const logger = createLogger('TelemetryTest');
  applyTelemetrySchema(db, logger);
  applyTelemetryTurnsMigrations(db, logger);
}
