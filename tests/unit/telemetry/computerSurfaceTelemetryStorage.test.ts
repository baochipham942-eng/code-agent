import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { TelemetryStorage } from '../../../src/main/telemetry/telemetryStorage';
import type { TelemetryToolCall } from '../../../src/shared/contract/telemetry';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

const makeToolCall = (
  overrides: Partial<TelemetryToolCall & { turnId: string; sessionId: string }>,
): TelemetryToolCall & { turnId: string; sessionId: string } => ({
  id: overrides.id ?? `record-${overrides.toolCallId ?? 'tool'}`,
  turnId: overrides.turnId ?? 'turn-1',
  sessionId: overrides.sessionId ?? 'session-1',
  toolCallId: overrides.toolCallId ?? overrides.id ?? 'tool-1',
  name: overrides.name ?? 'computer_use',
  arguments: overrides.arguments ?? '{}',
  actualArguments: overrides.actualArguments,
  resultSummary: overrides.resultSummary ?? '',
  success: overrides.success ?? true,
  error: overrides.error,
  errorCategory: overrides.errorCategory,
  durationMs: overrides.durationMs ?? 1,
  timestamp: overrides.timestamp ?? 1,
  index: overrides.index ?? 0,
  parallel: overrides.parallel ?? false,
  computerSurfaceFailureKind: overrides.computerSurfaceFailureKind,
  computerSurfaceMode: overrides.computerSurfaceMode,
  computerSurfaceTargetApp: overrides.computerSurfaceTargetApp,
  computerSurfaceAction: overrides.computerSurfaceAction,
  computerSurfaceAxQualityScore: overrides.computerSurfaceAxQualityScore,
  computerSurfaceAxQualityGrade: overrides.computerSurfaceAxQualityGrade,
});

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

  it('aggregates Computer Surface reliability counts, modes, failure kinds, and recent failures', () => {
    const storage = new TelemetryStorage();

    storage.batchInsert({
      toolCalls: [
        makeToolCall({
          id: 'record-success-foreground',
          toolCallId: 'tool-success-foreground',
          success: true,
          timestamp: 100,
          index: 0,
          computerSurfaceMode: 'foreground_fallback',
          computerSurfaceTargetApp: 'Finder',
          computerSurfaceAction: 'click',
        }),
        makeToolCall({
          id: 'record-fail-ax-1',
          toolCallId: 'tool-fail-ax-1',
          success: false,
          error: 'No locator',
          timestamp: 200,
          index: 1,
          computerSurfaceFailureKind: 'locator_missing',
          computerSurfaceMode: 'background_ax',
          computerSurfaceTargetApp: 'Safari',
          computerSurfaceAction: 'click',
        }),
        makeToolCall({
          id: 'record-fail-ax-2',
          toolCallId: 'tool-fail-ax-2',
          success: false,
          error: 'Still no locator',
          timestamp: 300,
          index: 2,
          computerSurfaceFailureKind: 'locator_missing',
          computerSurfaceMode: 'background_ax',
          computerSurfaceTargetApp: 'Safari',
          computerSurfaceAction: 'type',
        }),
        makeToolCall({
          id: 'record-fail-cgevent',
          toolCallId: 'tool-fail-cgevent',
          success: false,
          error: 'Window missing',
          timestamp: 400,
          index: 3,
          computerSurfaceFailureKind: 'target_window_not_found',
          computerSurfaceMode: 'background_cgevent',
          computerSurfaceTargetApp: 'Notes',
          computerSurfaceAction: 'click',
        }),
        makeToolCall({
          id: 'record-success-unknown-mode',
          toolCallId: 'tool-success-unknown-mode',
          success: true,
          timestamp: 500,
          index: 4,
        }),
        makeToolCall({
          id: 'record-non-computer',
          toolCallId: 'tool-non-computer',
          name: 'read_file',
          success: false,
          timestamp: 600,
          computerSurfaceFailureKind: 'permission_denied',
          computerSurfaceMode: 'background_ax',
        }),
      ],
    });

    expect(storage.getComputerSurfaceReliabilitySummary('session-1')).toEqual({
      sessionId: 'session-1',
      totalActions: 5,
      successfulActions: 2,
      failedActions: 3,
      foregroundFallbackActions: 1,
      backgroundAxActions: 2,
      backgroundCgEventActions: 1,
      byFailureKind: [
        { failureKind: 'locator_missing', count: 2 },
        { failureKind: 'target_window_not_found', count: 1 },
      ],
      byMode: [
        { mode: 'background_ax', count: 2, failed: 2 },
        { mode: 'background_cgevent', count: 1, failed: 1 },
        { mode: 'foreground_fallback', count: 1, failed: 0 },
      ],
      recentFailures: [
        {
          toolCallId: 'tool-fail-cgevent',
          timestamp: 400,
          name: 'computer_use',
          failureKind: 'target_window_not_found',
          mode: 'background_cgevent',
          targetApp: 'Notes',
          action: 'click',
          error: 'Window missing',
        },
        {
          toolCallId: 'tool-fail-ax-2',
          timestamp: 300,
          name: 'computer_use',
          failureKind: 'locator_missing',
          mode: 'background_ax',
          targetApp: 'Safari',
          action: 'type',
          error: 'Still no locator',
        },
        {
          toolCallId: 'tool-fail-ax-1',
          timestamp: 200,
          name: 'computer_use',
          failureKind: 'locator_missing',
          mode: 'background_ax',
          targetApp: 'Safari',
          action: 'click',
          error: 'No locator',
        },
      ],
    });
  });

  it('returns an empty reliability summary for sessions without Computer Surface telemetry', () => {
    const storage = new TelemetryStorage();

    expect(storage.getComputerSurfaceReliabilitySummary('empty-session')).toEqual({
      sessionId: 'empty-session',
      totalActions: 0,
      successfulActions: 0,
      failedActions: 0,
      foregroundFallbackActions: 0,
      backgroundAxActions: 0,
      backgroundCgEventActions: 0,
      byFailureKind: [],
      byMode: [],
      recentFailures: [],
    });
  });
});
