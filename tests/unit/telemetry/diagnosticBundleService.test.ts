import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/main/services/core/databaseService';
import { TelemetryStorage } from '../../../src/main/telemetry/telemetryStorage';
import { buildDiagnosticBundle, sanitizeDiagnosticBundle } from '../../../src/main/telemetry/diagnosticBundleService';
import type { DiagnosticBundle, TelemetrySession, TelemetryModelCall } from '../../../src/shared/contract/telemetry';

const dbState = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
}));

function session(id: string): TelemetrySession {
  return {
    id, userId: 'u1', title: id, modelProvider: 'openai', modelName: 'gpt-test',
    workingDirectory: os.tmpdir(), startTime: 100, turnCount: 0, totalInputTokens: 0,
    totalOutputTokens: 0, totalTokens: 0, estimatedCost: 0, totalToolCalls: 0,
    toolSuccessRate: 0, totalErrors: 0, status: 'completed',
    agentVersion: '9.9.9', promptVersion: 'sys-v1', toolSchemaVersion: 'tools-abc123',
  };
}

function modelCall(id: string, turnId: string, sessionId: string): TelemetryModelCall & { turnId: string; sessionId: string } {
  return {
    id, turnId, sessionId, timestamp: 100, provider: 'openai', model: 'gpt-test',
    inputTokens: 1, outputTokens: 1, latencyMs: 1, responseType: 'text',
    toolCallCount: 0, truncated: false, prompt: 'hello world', completion: 'hi',
  };
}

describe('buildDiagnosticBundle', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY, user_id TEXT, title TEXT NOT NULL, model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL, working_directory TEXT NOT NULL, start_time INTEGER NOT NULL,
        end_time INTEGER, duration_ms INTEGER, turn_count INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0, total_output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0, estimated_cost REAL DEFAULT 0, total_tool_calls INTEGER DEFAULT 0,
        tool_success_rate REAL DEFAULT 0, total_errors INTEGER DEFAULT 0, session_type TEXT,
        status TEXT DEFAULT 'recording', agent_version TEXT, prompt_version TEXT, tool_schema_version TEXT
      );
      CREATE TABLE telemetry_turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_number INTEGER, start_time INTEGER,
        end_time INTEGER, duration_ms INTEGER, agent_id TEXT, turn_type TEXT DEFAULT 'user', parent_turn_id TEXT
      );
      CREATE TABLE telemetry_model_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, temperature REAL, max_tokens INTEGER,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, latency_ms INTEGER DEFAULT 0,
        response_type TEXT, tool_call_count INTEGER DEFAULT 0, truncated INTEGER DEFAULT 0, error TEXT,
        fallback_info TEXT, prompt TEXT, completion TEXT
      );
      CREATE TABLE telemetry_tool_calls (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
        name TEXT NOT NULL, arguments TEXT, actual_arguments TEXT, result_summary TEXT, success INTEGER DEFAULT 0,
        error TEXT, error_category TEXT, computer_surface_failure_kind TEXT, computer_surface_mode TEXT,
        computer_surface_target_app TEXT, computer_surface_action TEXT, computer_surface_ax_quality_score REAL,
        computer_surface_ax_quality_grade TEXT, duration_ms INTEGER DEFAULT 0, timestamp INTEGER NOT NULL,
        idx INTEGER DEFAULT 0, parallel INTEGER DEFAULT 0
      );
      CREATE TABLE telemetry_events (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL, summary TEXT, data TEXT, duration_ms INTEGER
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

  it('returns null for unknown session', async () => {
    expect(await buildDiagnosticBundle('nope', { storage: new TelemetryStorage() })).toBeNull();
  });

  it('assembles versions, raw payloads and environment', async () => {
    const storage = new TelemetryStorage();
    storage.insertSession(session('sess-1'));
    storage.batchInsert({ modelCalls: [modelCall('m1', 'turn-1', 'sess-1')] });

    const bundle = await buildDiagnosticBundle('sess-1', { builtAt: 12345, storage });
    expect(bundle).not.toBeNull();
    expect(bundle!.builtAt).toBe(12345);
    // 版本指纹来自 session 行
    expect(bundle!.versions).toEqual({ agentVersion: '9.9.9', promptVersion: 'sys-v1', toolSchemaVersion: 'tools-abc123' });
    // 环境指纹
    expect(bundle!.environment.nodeVersion).toBe(process.version);
    expect(bundle!.environment.appVersion).toBeTruthy();
    expect(bundle!.environment.os).toContain(os.platform());
    // tmpdir 不是 git 仓库 → git 字段降级
    expect(bundle!.environment.git.dirty === null || typeof bundle!.environment.git.dirty === 'boolean').toBe(true);
    // raw 全量内容(prompt/completion)进包
    const fields = bundle!.rawPayloads.map((p) => p.field).sort();
    expect(fields).toEqual(['completion', 'prompt']);
    expect(bundle!.rawPayloads.find((p) => p.field === 'prompt')!.content).toBe('hello world');
  });
});

describe('sanitizeDiagnosticBundle', () => {
  function bundle(): DiagnosticBundle {
    return {
      bundleVersion: 1, builtAt: 1, sessionId: 's1',
      versions: { agentVersion: '1', promptVersion: 'p', toolSchemaVersion: 't' },
      environment: {
        os: 'darwin 25', arch: 'arm64', nodeVersion: 'v22', appVersion: '1.0',
        workingDirectory: '/Users/tester/proj', git: { branch: 'main', head: 'abc', dirty: false },
      },
      session: { ...session('s1'), workingDirectory: '/Users/tester/proj', title: 'open /Users/tester/proj' },
      turns: [{
        turn: { userPrompt: 'see /Users/tester/notes.txt', assistantResponse: 'ok', thinkingContent: undefined } as never,
        modelCalls: [], toolCalls: [],
      }],
      events: [],
      rawPayloads: [{
        turnId: 'turn-1', refKind: 'tool_call', refId: 't1', field: 'result',
        content: 'token sk-abcd1234efgh at /Users/tester/secret.env',
        byteLen: 49, truncated: false, createdAt: 1,
      }],
    };
  }

  it('scrubs home dir and secrets without mutating the original', () => {
    const original = bundle();
    const sanitized = sanitizeDiagnosticBundle(original, { homeDir: '/Users/tester' });

    // raw 内容:密钥打码 + 家目录 → ~
    const raw = sanitized.rawPayloads[0].content;
    expect(raw).not.toContain('sk-abcd1234efgh');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('/Users/tester');
    expect(raw).toContain('~/secret.env');
    // 自由文本字段也脱敏
    expect(sanitized.environment.workingDirectory).toBe('~/proj');
    expect(sanitized.session.title).toBe('open ~/proj');
    expect((sanitized.turns[0].turn as { userPrompt: string }).userPrompt).toBe('see ~/notes.txt');
    // 原对象未被改动
    expect(original.rawPayloads[0].content).toContain('sk-abcd1234efgh');
    expect(original.environment.workingDirectory).toBe('/Users/tester/proj');
  });
});
