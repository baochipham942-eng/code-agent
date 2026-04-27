import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { TelemetryStorage } from '../../../src/main/telemetry/telemetryStorage';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

describe('TelemetryStorage computer surface fields', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_tool_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT,
        actual_arguments TEXT,
        result_summary TEXT,
        success INTEGER DEFAULT 0,
        error TEXT,
        error_category TEXT,
        computer_surface_failure_kind TEXT,
        computer_surface_mode TEXT,
        computer_surface_target_app TEXT,
        computer_surface_action TEXT,
        computer_surface_ax_quality_score REAL,
        computer_surface_ax_quality_grade TEXT,
        duration_ms INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        idx INTEGER DEFAULT 0,
        parallel INTEGER DEFAULT 0
      )
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

  it('persists and reads Computer Surface reliability fields', () => {
    const storage = new TelemetryStorage();

    storage.batchInsert({
      toolCalls: [{
        id: 'record-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        name: 'computer_use',
        arguments: '{"action":"click","targetApp":"Finder"}',
        actualArguments: '{"action":"click","targetApp":"Finder"}',
        resultSummary: 'Background action failed',
        success: false,
        error: 'Background action failed',
        errorCategory: 'unknown',
        durationMs: 42,
        timestamp: 100,
        index: 0,
        parallel: false,
        computerSurfaceFailureKind: 'locator_missing',
        computerSurfaceMode: 'background_ax',
        computerSurfaceTargetApp: 'Finder',
        computerSurfaceAction: 'click',
        computerSurfaceAxQualityScore: 0.3,
        computerSurfaceAxQualityGrade: 'poor',
      }],
    });

    expect(storage.getToolCallsBySession('session-1')[0]).toMatchObject({
      actualArguments: '{"action":"click","targetApp":"Finder"}',
      computerSurfaceFailureKind: 'locator_missing',
      computerSurfaceMode: 'background_ax',
      computerSurfaceTargetApp: 'Finder',
      computerSurfaceAction: 'click',
      computerSurfaceAxQualityScore: 0.3,
      computerSurfaceAxQualityGrade: 'poor',
    });
  });
});
