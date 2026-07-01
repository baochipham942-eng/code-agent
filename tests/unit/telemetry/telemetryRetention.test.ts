import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { TELEMETRY_RETENTION } from '../../../src/shared/constants';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

const NOW = 1_800_000_000_000;
const OLD = NOW - TELEMETRY_RETENTION.MAX_AGE_MS - 1; // 刚过期
const FRESH = NOW - 1000; // 未过期

function count(table: string): number {
  return (dbState.sqlite!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('TelemetryStorage.pruneAgedTelemetry', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL, working_directory TEXT NOT NULL, start_time INTEGER NOT NULL,
        end_time INTEGER, duration_ms INTEGER, turn_count INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0, total_output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0, estimated_cost REAL DEFAULT 0, total_tool_calls INTEGER DEFAULT 0,
        tool_success_rate REAL DEFAULT 0, total_errors INTEGER DEFAULT 0, session_type TEXT, status TEXT
      );
      CREATE TABLE telemetry_turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_number INTEGER NOT NULL,
        start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, duration_ms INTEGER NOT NULL
      );
      CREATE TABLE telemetry_events (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, event_type TEXT NOT NULL, summary TEXT, data TEXT, duration_ms INTEGER
      );
      CREATE TABLE telemetry_model_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE telemetry_tool_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL, name TEXT NOT NULL, timestamp INTEGER NOT NULL
      );
      CREATE TABLE telemetry_diagnostic_bundles (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, trigger_reason TEXT NOT NULL,
        bundle_version INTEGER NOT NULL DEFAULT 1, built_at INTEGER NOT NULL, bundle TEXT NOT NULL,
        created_at INTEGER NOT NULL, synced_at INTEGER
      );
      CREATE TABLE system_prompt_cache (
        hash TEXT PRIMARY KEY, content TEXT NOT NULL, tokens INTEGER, created_at INTEGER NOT NULL
      );
    `);
    // 每张重量表塞一条过期 + 一条新鲜
    dbState.sqlite.exec(`
      INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time)
        VALUES ('s-old', 't', 'openai', 'm', '/tmp', ${OLD}), ('s-new', 't', 'openai', 'm', '/tmp', ${FRESH});
      INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, end_time, duration_ms)
        VALUES ('tn-old', 's-old', 1, ${OLD}, ${OLD}, 1), ('tn-new', 's-new', 1, ${FRESH}, ${FRESH}, 1);
      INSERT INTO telemetry_events (id, turn_id, session_id, timestamp, event_type)
        VALUES ('e-old', 'tn-old', 's-old', ${OLD}, 'x'), ('e-new', 'tn-new', 's-new', ${FRESH}, 'x');
      INSERT INTO telemetry_model_calls (id, turn_id, session_id, timestamp, provider, model)
        VALUES ('mc-old', 'tn-old', 's-old', ${OLD}, 'openai', 'm'), ('mc-new', 'tn-new', 's-new', ${FRESH}, 'openai', 'm');
      INSERT INTO telemetry_tool_calls (id, turn_id, session_id, tool_call_id, name, timestamp)
        VALUES ('tc-old', 'tn-old', 's-old', 'tc-old', 'Bash', ${OLD}), ('tc-new', 'tn-new', 's-new', 'tc-new', 'Bash', ${FRESH});
      INSERT INTO telemetry_diagnostic_bundles (id, session_id, trigger_reason, built_at, bundle, created_at)
        VALUES ('b-old', 's-old', 'x', ${OLD}, '{}', ${OLD}), ('b-new', 's-new', 'x', ${FRESH}, '{}', ${FRESH});
      INSERT INTO system_prompt_cache (hash, content, tokens, created_at)
        VALUES ('h-old', 'c', 1, ${OLD}), ('h-new', 'c', 1, ${FRESH});
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

  it('删除超过 MAX_AGE_MS 的 events/model_calls/tool_calls,保留新鲜行', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    for (const table of ['telemetry_events', 'telemetry_model_calls', 'telemetry_tool_calls']) {
      const rows = dbState.sqlite!.prepare(`SELECT id FROM ${table}`).all() as { id: string }[];
      expect(rows.map((r) => r.id).some((id) => id.endsWith('-old'))).toBe(false);
      expect(rows.map((r) => r.id).some((id) => id.endsWith('-new'))).toBe(true);
    }
  });

  it('按 created_at 删除过期 diagnostic_bundles 和 system_prompt_cache', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(count('telemetry_diagnostic_bundles')).toBe(1);
    expect(count('system_prompt_cache')).toBe(1);
    expect(dbState.sqlite!.prepare("SELECT id FROM telemetry_diagnostic_bundles").get()).toEqual({ id: 'b-new' });
    expect(dbState.sqlite!.prepare("SELECT hash FROM system_prompt_cache").get()).toEqual({ hash: 'h-new' });
  });

  it('保留 telemetry_sessions/turns 分析主干(不删,历史用量分析不丢)', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(count('telemetry_sessions')).toBe(2);
    expect(count('telemetry_turns')).toBe(2);
  });

  it('DB 不可用时是 no-op,不抛', () => {
    isReadySpy.mockReturnValue(false);
    expect(() => new TelemetryStorage().pruneAgedTelemetry(NOW)).not.toThrow();
    expect(count('telemetry_events')).toBe(2); // 未动
  });
});
