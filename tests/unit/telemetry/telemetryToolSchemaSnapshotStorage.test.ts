import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/services/infra/logger')>(),
  createLogger: () => loggerMock,
}));
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { TELEMETRY_TRUNCATION } from '../../../src/shared/constants';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

describe('TelemetryStorage tool_schema_snapshot persistence', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_events (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, event_type TEXT NOT NULL, summary TEXT,
        data TEXT, duration_ms INTEGER
      );
      CREATE TABLE telemetry_raw_payloads (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT,
        ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, field TEXT NOT NULL,
        content TEXT, byte_len INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    isReadySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => dbState.sqlite;
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    database.getDb = originalGetDb;
    isReadySpy.mockRestore();
    dbState.sqlite?.close();
    dbState.sqlite = null;
  });

  it('persists a snapshot larger than the tool-arguments cap as parseable JSON', () => {
    const tools = Array.from({ length: 18 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: {
        type: 'object',
        properties: {
          payload: {
            type: 'string',
            description: `schema-${index}-${'x'.repeat(700)}`,
          },
        },
        required: ['payload'],
      },
      requiresPermission: false,
      permissionLevel: 'read',
    }));
    const snapshot = JSON.stringify({ turnId: 'turn-1', toolCount: tools.length, tools });
    expect(snapshot.length).toBeGreaterThan(TELEMETRY_TRUNCATION.TOOL_ARGUMENTS);

    new TelemetryStorage().batchInsert({
      events: [{
        id: 'event-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        timestamp: 100,
        eventType: 'tool_schema_snapshot',
        summary: '18 tool schemas available',
        data: snapshot,
      }],
    });

    const row = dbState.sqlite!
      .prepare('SELECT data FROM telemetry_events WHERE id = ?')
      .get('event-1') as { data: string };
    expect(() => JSON.parse(row.data)).not.toThrow();
    expect(JSON.parse(row.data)).toEqual(JSON.parse(snapshot));
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('warns with event type and original length when the dedicated cap is exceeded', () => {
    const snapshot = JSON.stringify({
      turnId: 'turn-oversized',
      toolCount: 1,
      tools: [{ name: 'huge_tool', inputSchema: { description: 'x'.repeat(TELEMETRY_TRUNCATION.TOOL_SCHEMA_SNAPSHOT) } }],
    });

    new TelemetryStorage().batchInsert({
      events: [{
        id: 'event-oversized',
        turnId: 'turn-oversized',
        sessionId: 'session-1',
        timestamp: 200,
        eventType: 'tool_schema_snapshot',
        summary: '1 tool schema available',
        data: snapshot,
      }],
    });

    expect(loggerMock.warn).toHaveBeenCalledWith('Telemetry event data truncated', {
      eventType: 'tool_schema_snapshot',
      originalLength: snapshot.length,
      limit: TELEMETRY_TRUNCATION.TOOL_SCHEMA_SNAPSHOT,
    });
  });
});
