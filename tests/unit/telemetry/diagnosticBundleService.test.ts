import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { buildDiagnosticBundle, buildSessionLogExport, sanitizeDiagnosticBundle } from '../../../src/host/telemetry/diagnosticBundleService';
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

const SURFACE_CANARY = 'surface-secret-canary-diagnostic';
const SCREENSHOT_BINARY = 'A'.repeat(512);

function surfaceDiagnosticMetadata(): Record<string, unknown> {
  return {
    surfaceExecutionLedgerV1: {
      version: 1,
      conversationId: 'sess-1',
      updatedAt: 200,
      reasoning: 'raw private reasoning',
      sessions: [{
        version: 1,
        session: {
          version: 1,
          sessionId: 'surface-diagnostic',
          runId: 'run-diagnostic',
          conversationId: 'sess-1',
          agentId: 'agent-diagnostic',
          surface: 'browser',
          provider: 'managed',
          capabilities: {
            version: 1,
            surface: 'browser',
            provider: 'managed',
            protocolVersion: 'surface-execution-v1',
            operations: ['navigate'],
            observationKinds: ['screenshot'],
            supports: {
              cancel: true,
              pause: true,
              takeover: true,
              cleanup: true,
              successorObservation: true,
            },
          },
          state: 'completed',
          activeTarget: {
            kind: 'browser',
            browserInstanceId: 'browser-private',
            windowRef: 'window-private',
            tabRef: 'tab-private',
            documentRevision: 'revision-private',
          },
          startedAt: 100,
          heartbeatAt: 200,
        },
        grant: {
          state: 'revoked',
          capabilities: ['observe'],
          actionClasses: ['private-action'],
          dataScopes: [`cookie=${SURFACE_CANARY}`],
        },
        events: [{
          version: 1,
          eventId: 'event-verify',
          sequence: 1,
          sessionId: 'surface-diagnostic',
          conversationId: 'sess-1',
          runId: 'run-diagnostic',
          agentId: 'agent-diagnostic',
          surface: 'browser',
          provider: 'managed',
          sessionState: 'completed',
          phase: 'verify',
          status: 'succeeded',
          userSummary: `Visual verification passed ${SURFACE_CANARY}`,
          observation: {
            verdict: 'pass',
            findings: ['The generated page is visible'],
          },
          evidenceRefs: ['evidence-screenshot'],
          artifactRefs: ['artifact:generated-page'],
          availableControls: [],
          startedAt: 150,
          completedAt: 200,
        }],
        evidence: [{
          version: 1,
          evidenceId: 'evidence-screenshot',
          kind: 'screenshot',
          source: 'browser',
          title: 'Generated page screenshot',
          summary: `Captured at /Users/tester/private/${SURFACE_CANARY}.png`,
          capturedAt: 190,
          assetRef: `/Users/tester/private/${SURFACE_CANARY}.png`,
          redactionStatus: 'redacted',
          inspection: {
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'verified',
            inspectedBy: { kind: 'agent', id: 'vision-agent', method: 'vision' },
            inspectedAt: 195,
            supportsStepIds: ['verify-generated-page'],
            checklist: [{
              id: 'page-visible',
              label: 'Generated page is visible',
              status: 'passed',
            }],
          },
        }],
        outputs: [{
          ref: 'artifact:generated-page',
          kind: 'artifact',
          label: 'Generated page',
          createdAt: 200,
        }],
        availableControls: [],
        source: 'persisted',
        writable: false,
        updatedAt: 200,
      }],
    },
    token: 'token-value-private',
    cookie: 'cookie-value-private',
    selector: '#private-selector',
    profileDir: '/Users/tester/private/profile',
    downloadPath: `/private/tmp/${SURFACE_CANARY}.png`,
    screenshotBase64: SCREENSHOT_BINARY,
  };
}

describe('buildDiagnosticBundle', () => {
  let database: ReturnType<typeof getDatabase>;
  let originalGetDb: typeof database.getDb;
  let isReadySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbState.sqlite = new Database(':memory:');
    dbState.sqlite.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, metadata TEXT);
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

  it('adds a metadata-first Surface session, event, and evidence projection', async () => {
    const storage = new TelemetryStorage();
    storage.insertSession(session('sess-1'));
    dbState.sqlite!.prepare('INSERT INTO sessions (id, user_id, metadata) VALUES (?, ?, ?)').run(
      'sess-1',
      'u1',
      JSON.stringify(surfaceDiagnosticMetadata()),
    );

    const bundle = await buildDiagnosticBundle('sess-1', { builtAt: 12345, storage });
    const event = bundle?.events.find((candidate) => (
      candidate.eventType === 'surface_execution_projection'
    ));
    expect(event).toBeDefined();
    expect(event?.timestamp).toBe(12345);

    const data = JSON.parse(event!.data!) as {
      metadata: {
        surfaceExecutionExportV1: {
          sessions: Array<{ events: Array<Record<string, unknown>> }>;
        };
      };
    };
    expect(data.metadata.surfaceExecutionExportV1.sessions[0]).toMatchObject({
      sessionId: 'surface-diagnostic',
      surface: 'browser',
      provider: 'managed',
      state: 'completed',
      events: [{
        eventId: 'event-verify',
        phase: 'verify',
        status: 'succeeded',
        observation: { verdict: 'pass' },
        evidence: [{
          evidenceId: 'evidence-screenshot',
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'verified',
        }],
        artifactRefs: ['artifact:generated-page'],
      }],
    });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(SURFACE_CANARY);
    expect(serialized).not.toContain('token-value-private');
    expect(serialized).not.toContain('cookie-value-private');
    expect(serialized).not.toContain('#private-selector');
    expect(serialized).not.toContain('/Users/tester');
    expect(serialized).not.toContain(SCREENSHOT_BINARY);
    expect(serialized).not.toContain('browser-private');
    expect(serialized).not.toContain('raw private reasoning');
  });

  it('buildSessionLogExport: 脱敏 bundle + 日志尾部；会话不存在时 bundle 为 null 仍可导出', async () => {
    const storage = new TelemetryStorage();
    storage.insertSession(session('sess-2'));
    const logFile = path.join(os.tmpdir(), `neo-log-export-test-${process.pid}.log`);
    fs.writeFileSync(logFile, `{"level":"WARN","message":"[openai] API 错误: 404","data":"key sk-abcd1234efgh"}\n`);
    try {
      const result = await buildSessionLogExport('sess-2', {
        storage, exportedAt: 1718000000000, logFilePath: logFile,
      });
      const parsed = JSON.parse(result.content) as { sessionId: string; bundle: { session: { id: string } } | null; logTail: string | null };
      expect(parsed.sessionId).toBe('sess-2');
      expect(parsed.bundle!.session.id).toBe('sess-2');
      // 日志尾部进包且过脱敏（密钥打码）
      expect(parsed.logTail).toContain('API 错误: 404');
      expect(parsed.logTail).not.toContain('sk-abcd1234efgh');
      expect(result.suggestedFileName).toMatch(/^neo-session-log-sess-2-\d{4}-\d{2}-\d{2}\.json$/);

      // 会话不在 telemetry 存储（telemetry 关闭/历史会话）→ bundle null，日志尾部仍在
      const missing = await buildSessionLogExport('nope', { storage, logFilePath: logFile });
      const missingParsed = JSON.parse(missing.content) as { bundle: unknown; logTail: string | null };
      expect(missingParsed.bundle).toBeNull();
      expect(missingParsed.logTail).toContain('API 错误');
    } finally {
      fs.unlinkSync(logFile);
    }
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
        turn: {
          userPrompt: 'see /Users/tester/notes.txt',
          assistantResponse: 'ok',
          thinkingContent: 'raw private chain of thought',
        } as never,
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

  it('projects Surface metadata and removes canaries, authority, paths, and screenshot bytes', () => {
    const original = bundle();
    const rawSurfaceData = JSON.stringify({
      toolCallId: 'tool-surface',
      success: true,
      metadata: surfaceDiagnosticMetadata(),
    });
    original.events.push({
      id: 'event-surface',
      timestamp: 2,
      eventType: 'tool_call_end',
      summary: `Surface result ${SURFACE_CANARY}`,
      data: rawSurfaceData,
    });
    original.rawPayloads.push({
      turnId: 'turn-1',
      refKind: 'tool_call',
      refId: 'surface-result',
      field: 'result',
      content: rawSurfaceData,
      byteLen: Buffer.byteLength(rawSurfaceData),
      truncated: false,
      createdAt: 2,
    });

    const sanitized = sanitizeDiagnosticBundle(original, { homeDir: '/Users/tester' });
    const sanitizedEvent = sanitized.events.find((event) => event.id === 'event-surface');
    const parsedEvent = JSON.parse(sanitizedEvent!.data!) as {
      metadata: {
        surfaceExecutionExportV1: {
          sessions: Array<{ events: Array<Record<string, unknown>> }>;
        };
      };
    };
    expect(parsedEvent.metadata.surfaceExecutionExportV1.sessions[0]).toMatchObject({
      sessionId: 'surface-diagnostic',
      state: 'completed',
      events: [{
        phase: 'verify',
        observation: { verdict: 'pass' },
        evidence: [{
          captureState: 'captured',
          analysisState: 'analyzed',
          verificationState: 'verified',
        }],
      }],
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('[redacted-canary]');
    expect(serialized).not.toContain(SURFACE_CANARY);
    expect(serialized).not.toContain('token-value-private');
    expect(serialized).not.toContain('cookie-value-private');
    expect(serialized).not.toContain('#private-selector');
    expect(serialized).not.toContain('/Users/tester');
    expect(serialized).not.toContain('/private/tmp');
    expect(serialized).not.toContain(SCREENSHOT_BINARY);
    expect(serialized).not.toContain('surfaceExecutionLedgerV1');
    expect(serialized).not.toContain('browser-private');
    expect(serialized).not.toContain('raw private chain of thought');
    expect(sanitized.turns[0].turn.thinkingContent).toBeUndefined();

    expect(original.events[0].data).toContain(SURFACE_CANARY);
    expect(original.rawPayloads[1].content).toContain(SCREENSHOT_BINARY);
  });
});
