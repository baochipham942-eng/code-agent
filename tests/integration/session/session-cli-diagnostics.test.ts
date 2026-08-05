import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testRequire = Module.createRequire(import.meta.url);
const NativeDatabase = testRequire('better-sqlite3') as typeof import('better-sqlite3');

describe('session diagnostics CLI projections', () => {
  let root: string;
  let dbPath: string;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-session-cli-'));
    dbPath = path.join(root, 'code-agent.db');
    process.env.CODE_AGENT_DATA_DIR = root;
    const db = new NativeDatabase(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, model_provider TEXT, model_name TEXT,
        working_directory TEXT, workspace TEXT, status TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER,
        tool_calls TEXT, tool_results TEXT, content_parts TEXT, thinking TEXT, metadata TEXT, is_meta INTEGER DEFAULT 0
      );
      CREATE TABLE session_task_events (id INTEGER PRIMARY KEY, session_id TEXT, task_id TEXT, at INTEGER, kind TEXT, summary TEXT, actor TEXT);
      CREATE TABLE permission_decisions (
        id INTEGER PRIMARY KEY, session_id TEXT, tool_name TEXT, summary TEXT,
        final_outcome TEXT, history_outcome TEXT, reason TEXT, duration_ms INTEGER,
        recorded_at INTEGER, trace_json TEXT
      );
      CREATE TABLE tool_execution_events (
        id INTEGER PRIMARY KEY, execution_id TEXT, session_id TEXT, tool_name TEXT,
        summary TEXT, params_json TEXT, phase TEXT, status TEXT, error TEXT, recorded_at INTEGER
      );
      CREATE TABLE swarm_runs (
        id TEXT PRIMARY KEY, session_id TEXT, coordinator TEXT, status TEXT, started_at INTEGER,
        ended_at INTEGER, total_agents INTEGER, completed_count INTEGER, failed_count INTEGER,
        total_cost_usd REAL, total_tokens_in INTEGER, total_tokens_out INTEGER, trigger TEXT
      );
      CREATE TABLE swarm_run_events (
        id INTEGER PRIMARY KEY, run_id TEXT, seq INTEGER, timestamp INTEGER, event_type TEXT,
        agent_id TEXT, level TEXT, title TEXT, summary TEXT, payload_json TEXT
      );
      CREATE TABLE telemetry_sessions (
        id TEXT PRIMARY KEY, estimated_cost REAL, total_input_tokens INTEGER, total_output_tokens INTEGER,
        agent_version TEXT, prompt_version TEXT, tool_schema_version TEXT
      );
      CREATE TABLE telemetry_turns (
        id TEXT PRIMARY KEY, session_id TEXT, turn_number INTEGER, start_time INTEGER,
        end_time INTEGER, duration_ms INTEGER, outcome_status TEXT, agent_id TEXT, turn_type TEXT
      );
      CREATE TABLE telemetry_tool_calls (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, tool_call_id TEXT, name TEXT,
        success INTEGER, error TEXT, duration_ms INTEGER, timestamp INTEGER, idx INTEGER
      );
    `);
    db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'session-1', 'CLI diagnostics', 'openai', 'gpt-test', '/work/project', null, 'idle', 1_000, 2_000,
    );
    db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'message-1', 'session-1', 'assistant', 'tool failed', 1_500, null,
      JSON.stringify([{ toolCallId: 'tool-1', success: false, error: 'command failed' }]),
      null, null, JSON.stringify({
        correlation: { turnId: 'turn-1', traceId: 'trace-1' },
        agentError: { rawMessage: 'model failed', category: 'generic', timestamp: 1_500 },
      }), 0,
    );
    db.prepare(`INSERT INTO permission_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      1, 'session-1', 'Bash', 'blocked', 'deny', 'policy-deny', 'not allowed', 2, 1_400,
      JSON.stringify({ turnId: 'turn-1' }),
    );
    db.prepare(`INSERT INTO tool_execution_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      1, 'exec-1', 'session-1', 'Bash', 'run command', '{}', 'complete', 'error', 'command failed', 1_600,
    );
    db.prepare(`INSERT INTO telemetry_sessions VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'session-1', 0.01, 12, 8, '0.30.0', 'p1', 't1',
    );
    db.prepare(`INSERT INTO telemetry_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'turn-1', 'session-1', 1, 1_000, 1_800, 800, 'error', 'main', 'user',
    );
    db.prepare(`INSERT INTO telemetry_tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'telemetry-tool-1', 'session-1', 'turn-1', 'tool-1', 'Bash', 0, 'command failed', 100, 1_600, 0,
    );
    db.close();

    fs.mkdirSync(path.join(root, 'logs'));
    fs.mkdirSync(path.join(root, 'audit'));
    fs.writeFileSync(path.join(root, 'logs', 'code-agent-2026-08-06.log'), `${JSON.stringify({
      timestamp: '2026-08-06T00:00:01.000Z', level: 'ERROR', sessionId: 'session-1',
      turnId: 'turn-1', toolCallId: 'tool-1', lane: 'sandbox', context: 'Bash', message: 'shell failed',
    })}\n`);
    fs.writeFileSync(path.join(root, 'audit', '2026-08-06.jsonl'), `${JSON.stringify({
      timestamp: 1_600, timestampISO: '2026-08-06T00:00:01.000Z', sessionId: 'session-1',
      turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'Bash', success: false, error: 'audit failed',
    })}\n`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function loadModules() {
    vi.doUnmock('better-sqlite3');
    const databaseModule = await import('../../../src/cli/sessionDiagnostics/readOnlySessionDb');
    const queryModule = await import('../../../src/cli/sessionDiagnostics/sessionQueries');
    return { ...databaseModule, ...queryModule };
  }

  it('opens the database query-only and builds list plus ledger/turn timeline', async () => {
    const { ReadOnlySessionDatabase, buildTimeline } = await loadModules();
    const db = new ReadOnlySessionDatabase(dbPath);
    try {
      expect(db.listSessions({ project: '/work/project', limit: 10 })).toEqual([
        expect.objectContaining({ id: 'session-1', messageCount: 1, project: '/work/project' }),
      ]);
      const timeline = buildTimeline(db, 'session-1', 9_999);
      expect(timeline.generatedAt).toBe(9_999);
      expect(timeline.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ lane: 'message', refId: 'message-1' }),
        expect.objectContaining({ lane: 'decision', kind: 'deny' }),
        expect.objectContaining({ lane: 'execution', kind: 'complete:error' }),
      ]));
      expect(timeline.telemetryTurns).toEqual([
        expect.objectContaining({ turnId: 'turn-1', outcomeStatus: 'error' }),
      ]);
      expect(() => db.getNativeDatabase().prepare(
        `INSERT INTO sessions (id) VALUES ('forbidden')`,
      ).run()).toThrow(/readonly|read-only/i);
    } finally {
      db.close();
    }
  });

  it('generates a deterministic digest from telemetry, audit, messages and correlated logs', async () => {
    const { ReadOnlySessionDatabase, buildFailureDigest } = await loadModules();
    const db = new ReadOnlySessionDatabase(dbPath);
    try {
      const digest = buildFailureDigest({ db, dataDir: root, sessionId: 'session-1', turnId: 'turn-1' });
      expect(digest).toMatchObject({
        sessionId: 'session-1', turnId: 'turn-1', permissionDenies: 1,
        versions: { appVersion: '0.30.0', promptVersion: 'p1', toolSchemaVersion: 't1' },
      });
      expect(digest.errorSummary).toBeTruthy();
      expect(digest.lastTools).toEqual([
        { name: 'Bash', success: false, error: 'command failed' },
      ]);
      expect(digest.logExcerpt).toEqual([
        expect.objectContaining({ lane: 'sandbox', context: 'Bash', message: 'shell failed' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps --json stdout parseable without progress or logger noise', async () => {
    vi.doUnmock('better-sqlite3');
    const { Command } = await import('commander');
    const { sessionCommand } = await import('../../../src/cli/commands/session');
    (sessionCommand as unknown as { parent?: unknown }).parent = undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const program = new Command().exitOverride().option('--json').addCommand(sessionCommand);
    await program.parseAsync(['node', 'neo', 'session', 'timeline', 'session-1', '--json']);
    const parsed = JSON.parse(stdout.join('')) as { sessionId: string; telemetryTurns: unknown[] };
    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.telemetryTurns).toHaveLength(1);
    expect(stderr).toEqual([]);
  });
});
