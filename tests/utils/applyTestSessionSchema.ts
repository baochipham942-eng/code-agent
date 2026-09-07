import type Database from 'better-sqlite3';
import { applySchema } from '../../src/host/services/core/database/schema';
import {
  applySessionsMigrations,
  applyTelemetryTurnsMigrations,
} from '../../src/host/services/core/database/migrations';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Parameters<typeof applySchema>[1];

/**
 * Apply the production host schema (plus the session/telemetry column
 * migrations databaseService runs next) so test databases cannot drift
 * from the live `messages` / `sessions` DDL.
 */
export function applyTestSessionSchema(db: Database.Database): void {
  applySchema(db, silentLogger);
  applySessionsMigrations(db, silentLogger);
  applyTelemetryTurnsMigrations(db, silentLogger);
}
