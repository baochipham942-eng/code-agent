import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const originalLogDir = process.env.CODE_AGENT_LOG_DIR;
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
let tempRoot: string | null = null;

async function waitForLine(filePath: string, needle: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      const match = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => JSON.stringify(line).includes(needle));
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${needle} in ${filePath}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalLogDir === undefined) delete process.env.CODE_AGENT_LOG_DIR;
  else process.env.CODE_AGENT_LOG_DIR = originalLogDir;
  if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('session correlation join', () => {
  it('joins one real Bash invocation across app log, audit, telemetry_tool_calls, and messages', async () => {
    vi.resetModules();
    vi.doUnmock('better-sqlite3');
    tempRoot = mkdtempSync(join(tmpdir(), 'neo-correlation-join-'));
    const logDir = join(tempRoot, 'logs');
    const auditDir = join(tempRoot, 'audit');
    mkdirSync(auditDir, { recursive: true });
    process.env.CODE_AGENT_LOG_DIR = logDir;
    process.env.CODE_AGENT_DATA_DIR = tempRoot;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { AuditLogger } = await import('../../../src/host/security/auditLogger');
    const { createLogger, getCurrentLogFilePath } = await import('../../../src/host/services/infra/logger');
    const { default: Database } = await import('better-sqlite3');
    const {
      createChildRunTraceContext,
      createRunTraceContext,
      withRunTraceContext,
    } = await import('../../../src/host/telemetry/runTraceContext');

    const sessionId = 'session-correlation';
    const turnId = 'turn-correlation';
    const toolCallId = 'tool-correlation';
    const run = createRunTraceContext({
      runId: 'run-correlation',
      sessionId,
      attempt: 1,
      ownerEpoch: 1,
      engine: 'native',
      workspace: tempRoot,
      processInstanceId: 'process-correlation',
    });
    const turn = createChildRunTraceContext(run, { turnId });
    const tool = createChildRunTraceContext(turn, { toolCallId });
    const appLogger = createLogger('BashTool');
    const auditLogger = new AuditLogger(auditDir);
    const db = new Database(join(tempRoot, 'join.db'));
    db.exec(`
      CREATE TABLE telemetry_tool_calls (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        success INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_results TEXT,
        metadata TEXT
      );
    `);

    await withRunTraceContext(tool, async () => {
      const { stdout } = await execFileAsync('/bin/bash', ['-lc', 'printf correlation-ok']);
      appLogger.info('Bash tool execution completed', { toolCallId, stdout });
      auditLogger.logToolUsage({
        sessionId,
        toolName: 'Bash',
        input: { command: 'printf correlation-ok' },
        output: stdout,
        duration: 1,
        success: true,
      });
      db.prepare(`
        INSERT INTO telemetry_tool_calls (session_id, turn_id, tool_call_id, name, success)
        VALUES (?, ?, ?, 'Bash', 1)
      `).run(sessionId, turnId, toolCallId);
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, tool_results, metadata)
        VALUES (?, ?, 'tool', ?, ?, ?)
      `).run(
        'message-tool-correlation',
        sessionId,
        JSON.stringify([{ toolCallId, success: true, output: stdout }]),
        JSON.stringify([{ toolCallId, success: true, output: stdout }]),
        JSON.stringify({ correlation: { turnId, traceId: run.traceId } }),
      );
    });

    await appLogger.dispose();
    auditLogger.close();
    const logLine = await waitForLine(getCurrentLogFilePath(), 'Bash tool execution completed');
    const auditLine = await waitForLine(
      join(auditDir, `${new Date().toISOString().split('T')[0]}.jsonl`),
      toolCallId,
    );
    const telemetryRow = db.prepare(
      'SELECT session_id, turn_id, tool_call_id, name, success FROM telemetry_tool_calls WHERE tool_call_id = ?',
    ).get(toolCallId) as Record<string, unknown>;
    const messageRow = db.prepare(
      'SELECT session_id, tool_results, metadata FROM messages WHERE session_id = ?',
    ).get(sessionId) as { session_id: string; tool_results: string; metadata: string };
    db.close();

    expect(logLine).toMatchObject({ sessionId, turnId, toolCallId, traceId: run.traceId });
    expect(auditLine).toMatchObject({ sessionId, turnId, toolCallId, traceId: run.traceId });
    expect(telemetryRow).toMatchObject({
      session_id: sessionId,
      turn_id: turnId,
      tool_call_id: toolCallId,
      name: 'Bash',
      success: 1,
    });
    expect(JSON.parse(messageRow.tool_results)).toEqual([
      expect.objectContaining({ toolCallId, success: true, output: 'correlation-ok' }),
    ]);
    expect(JSON.parse(messageRow.metadata)).toMatchObject({
      correlation: { turnId, traceId: run.traceId },
    });
  });
});
