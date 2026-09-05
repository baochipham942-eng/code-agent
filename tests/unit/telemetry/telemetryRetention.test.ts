import { applyTestTelemetrySchema } from '../../utils/telemetrySchema';
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
    applyTestTelemetrySchema(dbState.sqlite);
    // 每张重量表塞一条过期 + 一条新鲜
    dbState.sqlite.exec(`
      INSERT INTO telemetry_sessions (id, title, model_provider, model_name, working_directory, start_time, synced_at)
        VALUES
          ('s-old', 't', 'openai', 'm', '/tmp', ${OLD}, NULL),
          ('s-old-synced', 't', 'openai', 'm', '/tmp', ${OLD}, ${NOW}),
          ('s-new', 't', 'openai', 'm', '/tmp', ${FRESH}, NULL);
      INSERT INTO telemetry_turns (id, session_id, turn_number, start_time, end_time, duration_ms)
        VALUES
          ('tn-old', 's-old', 1, ${OLD}, ${OLD}, 1),
          ('tn-old-synced', 's-old-synced', 1, ${OLD}, ${OLD}, 1),
          ('tn-new', 's-new', 1, ${FRESH}, ${FRESH}, 1);
      INSERT INTO telemetry_events (id, turn_id, session_id, timestamp, event_type)
        VALUES ('e-old', 'tn-old', 's-old', ${OLD}, 'x'), ('e-new', 'tn-new', 's-new', ${FRESH}, 'x');
      INSERT INTO telemetry_model_calls (id, turn_id, session_id, timestamp, provider, model)
        VALUES
          ('mc-old', 'tn-old', 's-old', ${OLD}, 'openai', 'm'),
          ('mc-old-synced', 'tn-old-synced', 's-old-synced', ${OLD}, 'openai', 'm'),
          ('mc-new', 'tn-new', 's-new', ${FRESH}, 'openai', 'm');
      INSERT INTO telemetry_tool_calls (id, turn_id, session_id, tool_call_id, name, timestamp)
        VALUES
          ('tc-old', 'tn-old', 's-old', 'tc-old', 'Bash', ${OLD}),
          ('tc-old-synced', 'tn-old-synced', 's-old-synced', 'tc-old-synced', 'Bash', ${OLD}),
          ('tc-new', 'tn-new', 's-new', 'tc-new', 'Bash', ${FRESH});
      INSERT INTO telemetry_diagnostic_bundles (id, session_id, trigger_reason, built_at, bundle, created_at, synced_at)
        VALUES ('b-old', 's-old', 'x', ${OLD}, '{}', ${OLD}, ${NOW}), ('b-new', 's-new', 'x', ${FRESH}, '{}', ${FRESH}, NULL);
      INSERT INTO system_prompt_cache (hash, content, tokens, created_at)
        VALUES ('h-old', 'c', 1, ${OLD}), ('h-new', 'c', 1, ${FRESH});
      INSERT INTO tool_schema_cache (hash, content, created_at)
        VALUES ('t-old', '[]', ${OLD}), ('t-new', '[]', ${FRESH});
      INSERT INTO content_cache (hash, content, created_at)
        VALUES ('c-old', '{}', ${OLD}), ('c-new', '{}', ${FRESH});
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

  it('保留未同步 session 的过期 model/tool calls', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(dbState.sqlite!.prepare('SELECT id FROM telemetry_model_calls WHERE id = ?').get('mc-old'))
      .toEqual({ id: 'mc-old' });
    expect(dbState.sqlite!.prepare('SELECT id FROM telemetry_tool_calls WHERE id = ?').get('tc-old'))
      .toEqual({ id: 'tc-old' });
  });

  it('删除已同步 session 的过期 model/tool calls', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(dbState.sqlite!.prepare('SELECT id FROM telemetry_model_calls WHERE id = ?').get('mc-old-synced'))
      .toBeUndefined();
    expect(dbState.sqlite!.prepare('SELECT id FROM telemetry_tool_calls WHERE id = ?').get('tc-old-synced'))
      .toBeUndefined();
  });

  it('删除过期 events，保留新鲜明细行', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(dbState.sqlite!.prepare('SELECT id FROM telemetry_events WHERE id = ?').get('e-old')).toBeUndefined();
    for (const [table, id] of [
      ['telemetry_events', 'e-new'],
      ['telemetry_model_calls', 'mc-new'],
      ['telemetry_tool_calls', 'tc-new'],
    ]) {
      expect(dbState.sqlite!.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)).toEqual({ id });
    }
  });

  it('按 created_at 删除过期 diagnostic_bundles 和内容缓存', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(count('telemetry_diagnostic_bundles')).toBe(1);
    expect(count('system_prompt_cache')).toBe(1);
    expect(count('tool_schema_cache')).toBe(1);
    expect(count('content_cache')).toBe(1);
    expect(dbState.sqlite!.prepare("SELECT id FROM telemetry_diagnostic_bundles").get()).toEqual({ id: 'b-new' });
    expect(dbState.sqlite!.prepare("SELECT hash FROM system_prompt_cache").get()).toEqual({ hash: 'h-new' });
    expect(dbState.sqlite!.prepare("SELECT hash FROM tool_schema_cache").get()).toEqual({ hash: 't-new' });
    expect(dbState.sqlite!.prepare("SELECT hash FROM content_cache").get()).toEqual({ hash: 'c-new' });
  });

  it('保留超过 MAX_AGE_MS 但尚未上传的 diagnostic bundle', () => {
    dbState.sqlite!.prepare(`
      INSERT INTO telemetry_diagnostic_bundles
        (id, session_id, trigger_reason, built_at, bundle, created_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run('b-old-unsynced', 's-old', 'x', OLD, '{}', OLD);

    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(dbState.sqlite!.prepare(
      'SELECT id FROM telemetry_diagnostic_bundles WHERE id = ?',
    ).get('b-old-unsynced')).toEqual({ id: 'b-old-unsynced' });
  });

  it('删除超过 MAX_AGE_MS 且已经上传的 diagnostic bundle', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(dbState.sqlite!.prepare(
      'SELECT id FROM telemetry_diagnostic_bundles WHERE id = ?',
    ).get('b-old')).toBeUndefined();
  });

  it('保留 telemetry_sessions/turns 分析主干(不删,历史用量分析不丢)', () => {
    new TelemetryStorage().pruneAgedTelemetry(NOW);

    expect(count('telemetry_sessions')).toBe(3);
    expect(count('telemetry_turns')).toBe(3);
  });

  it('DB 不可用时是 no-op,不抛', () => {
    isReadySpy.mockReturnValue(false);
    expect(() => new TelemetryStorage().pruneAgedTelemetry(NOW)).not.toThrow();
    expect(count('telemetry_events')).toBe(2); // 未动
  });

  it('中央 schema 冷启动即可跑 retention（issue #1072：system_prompt_cache 曾惰性建表拖死整个事务）', async () => {
    const { applyTelemetrySchema } = await import('../../../src/host/services/core/database/schemaTelemetry');
    const { applyTelemetryTurnsMigrations } = await import('../../../src/host/services/core/database/migrations');
    const fresh = new Database(':memory:');
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    applyTelemetrySchema(fresh, noop as never);
    applyTelemetryTurnsMigrations(fresh, noop as never);
    fresh.prepare('INSERT INTO telemetry_events (id, turn_id, session_id, timestamp, event_type) VALUES (?, ?, ?, ?, ?)')
      .run('aged', 't1', 's1', OLD, 'tool_call');
    const { deleteAgedTelemetryRows } = await import('../../../src/host/telemetry/telemetryRetentionSql');
    // 直接调底层（不经 pruneAgedTelemetry 的吞错 catch）：任何表缺失都会在这里炸红
    expect(() => deleteAgedTelemetryRows(fresh, NOW)).not.toThrow();
    expect((fresh.prepare('SELECT COUNT(*) AS n FROM telemetry_events').get() as { n: number }).n).toBe(0);
    fresh.close();
  });
});
