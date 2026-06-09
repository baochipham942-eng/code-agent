import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { TelemetryStorage } from '../../../src/main/telemetry/telemetryStorage';
import type { TelemetryDiagnosticBundleRecord } from '../../../src/shared/contract/telemetry';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

function record(id: string, createdAt: number): TelemetryDiagnosticBundleRecord {
  return {
    id, sessionId: `sess-${id}`, agentVersion: '1.0', promptVersion: 'sys-v1',
    toolSchemaVersion: 'tools-x', triggerReason: 'session_error', bundleVersion: 1,
    builtAt: createdAt, bundle: JSON.stringify({ hello: id }), createdAt, syncedAt: null,
  };
}

describe('TelemetryStorage diagnostic bundle queue', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_diagnostic_bundles (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_version TEXT, prompt_version TEXT,
        tool_schema_version TEXT, trigger_reason TEXT NOT NULL, bundle_version INTEGER NOT NULL DEFAULT 1,
        built_at INTEGER NOT NULL, bundle TEXT NOT NULL, created_at INTEGER NOT NULL, synced_at INTEGER
      );
    `);
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => dbState.sqlite;
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('enqueues, lists unsynced in created order, and marks synced', () => {
    const storage = new TelemetryStorage();
    storage.insertDiagnosticBundle(record('a', 100));
    storage.insertDiagnosticBundle(record('b', 200));

    let unsynced = storage.getUnsyncedDiagnosticBundles();
    expect(unsynced.map((r) => r.id)).toEqual(['a', 'b']);
    expect(unsynced[0].triggerReason).toBe('session_error');
    expect(JSON.parse(unsynced[0].bundle)).toEqual({ hello: 'a' });

    storage.markDiagnosticBundlesSynced(['a'], 999);
    unsynced = storage.getUnsyncedDiagnosticBundles();
    expect(unsynced.map((r) => r.id)).toEqual(['b']);
  });

  it('respects the limit', () => {
    const storage = new TelemetryStorage();
    for (let i = 0; i < 5; i += 1) storage.insertDiagnosticBundle(record(`r${i}`, 100 + i));
    expect(storage.getUnsyncedDiagnosticBundles(3)).toHaveLength(3);
  });
});
