import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { TelemetryStorage, prepareRawPayload } from '../../../src/main/telemetry/telemetryStorage';
import { TELEMETRY_RAW } from '../../../src/shared/constants';
import type { TelemetryModelCall, TelemetryToolCall } from '../../../src/shared/contract/telemetry';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

function modelCall(id: string, turnId: string, sessionId: string, timestamp: number, prompt: string, completion: string): TelemetryModelCall & { turnId: string; sessionId: string } {
  return {
    id, turnId, sessionId, timestamp,
    provider: 'openai', model: 'gpt-test',
    inputTokens: 1, outputTokens: 1, latencyMs: 1,
    responseType: 'text', toolCallCount: 0, truncated: false,
    prompt, completion,
  };
}

function toolCall(id: string, turnId: string, sessionId: string, timestamp: number, args: string, result: string): TelemetryToolCall & { turnId: string; sessionId: string } {
  return {
    id, turnId, sessionId, timestamp,
    toolCallId: id, name: 'Bash', arguments: args, resultSummary: result,
    success: true, durationMs: 1, index: 0, parallel: false,
  };
}

describe('TelemetryStorage raw payloads', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE telemetry_model_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        temperature REAL, max_tokens INTEGER, input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0, latency_ms INTEGER DEFAULT 0, response_type TEXT,
        tool_call_count INTEGER DEFAULT 0, truncated INTEGER DEFAULT 0, error TEXT,
        fallback_info TEXT, prompt TEXT, completion TEXT
      );
      CREATE TABLE telemetry_tool_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT, actual_arguments TEXT,
        result_summary TEXT, success INTEGER DEFAULT 0, error TEXT, error_category TEXT,
        computer_surface_failure_kind TEXT, computer_surface_mode TEXT,
        computer_surface_target_app TEXT, computer_surface_action TEXT,
        computer_surface_ax_quality_score REAL, computer_surface_ax_quality_grade TEXT,
        duration_ms INTEGER DEFAULT 0, timestamp INTEGER NOT NULL, idx INTEGER DEFAULT 0, parallel INTEGER DEFAULT 0
      );
      CREATE TABLE telemetry_events (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, event_type TEXT NOT NULL, summary TEXT, data TEXT, duration_ms INTEGER
      );
      CREATE TABLE telemetry_raw_payloads (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, ref_kind TEXT NOT NULL,
        ref_id TEXT NOT NULL, field TEXT NOT NULL, content TEXT, byte_len INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
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

  it('keeps full content (no 2K truncation) and masks secrets', () => {
    const storage = new TelemetryStorage();
    const longResult = 'X'.repeat(5000); // 远超聚合表的 2000 截断
    storage.batchInsert({
      modelCalls: [modelCall('m1', 'turn-1', 'sess-1', 100, 'use key sk-abcd1234efgh now', 'done')],
      toolCalls: [toolCall('t1', 'turn-1', 'sess-1', 100, '{"command":"ls"}', longResult)],
    });

    const raw = storage.getRawPayloadsForSession('sess-1');
    const byField = Object.fromEntries(raw.map((r) => [r.field, r]));

    // 全量保留:result 5000 字未被砍到 2000
    expect(byField.result.content.length).toBe(5000);
    // 密钥掩码:sk- token 被红action
    expect(byField.prompt.content).not.toContain('sk-abcd1234efgh');
    expect(byField.prompt.content).toContain('REDACTED');
    expect(byField.completion.content).toBe('done');
  });

  // 直接测 prepareRawPayload:绕开聚合表的 guardTelemetryText(对超大输入极慢,属既有问题)
  it('caps a single payload at PER_PAYLOAD_MAX_BYTES and records original length', () => {
    const huge = 'Y'.repeat(TELEMETRY_RAW.PER_PAYLOAD_MAX_BYTES + 1000);
    const prepared = prepareRawPayload(huge)!;
    expect(prepared.truncated).toBe(true);
    expect(prepared.byteLen).toBe(TELEMETRY_RAW.PER_PAYLOAD_MAX_BYTES + 1000);
    expect(Buffer.byteLength(prepared.content, 'utf8')).toBeLessThanOrEqual(TELEMETRY_RAW.PER_PAYLOAD_MAX_BYTES);
    // 密钥掩码仍生效
    expect(prepareRawPayload('token sk-abcd1234efgh')!.content).toContain('REDACTED');
    // 空值返回 null
    expect(prepareRawPayload('')).toBeNull();
    expect(prepareRawPayload(null)).toBeNull();
  });

  it('prunes payloads older than RETENTION_MAX_AGE_MS', () => {
    const storage = new TelemetryStorage();
    const now = 1_000_000_000_000;
    const old = now - TELEMETRY_RAW.RETENTION_MAX_AGE_MS - 1;
    storage.batchInsert({ modelCalls: [modelCall('m-old', 'turn-old', 'sess-1', old, 'p', 'c')] });
    storage.batchInsert({ modelCalls: [modelCall('m-new', 'turn-new', 'sess-1', now, 'p', 'c')] });

    storage.pruneRawPayloads(now);

    const turns = new Set(storage.getRawPayloadsForSession('sess-1').map((r) => r.turnId));
    expect(turns.has('turn-old')).toBe(false);
    expect(turns.has('turn-new')).toBe(true);
  });

  it('keeps only the most recent RETENTION_MAX_TURNS turns', () => {
    const storage = new TelemetryStorage();
    const base = 1_000_000_000_000;
    const total = TELEMETRY_RAW.RETENTION_MAX_TURNS + 5;
    for (let i = 0; i < total; i += 1) {
      storage.batchInsert({ modelCalls: [modelCall(`m${i}`, `turn-${i}`, 'sess-1', base + i, 'p', 'c')] });
    }
    storage.pruneRawPayloads(base + total + 1);

    const turns = new Set(storage.getRawPayloadsForSession('sess-1').map((r) => r.turnId));
    expect(turns.size).toBe(TELEMETRY_RAW.RETENTION_MAX_TURNS);
    // 最旧的 5 个被淘汰
    expect(turns.has('turn-0')).toBe(false);
    expect(turns.has(`turn-${total - 1}`)).toBe(true);
  });
});
