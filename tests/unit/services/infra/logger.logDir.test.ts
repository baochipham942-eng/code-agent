import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalLogDir = process.env.CODE_AGENT_LOG_DIR;
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
let tempRoot: string | null = null;

async function waitForLogFile(filePath: string, needle = 'log-dir-override-smoke'): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const content = readFileSync(filePath, 'utf8');
      if (content.includes(needle)) return content;
    } catch {
      // wait for stream flush
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readFileSync(filePath, 'utf8');
}

describe('logger file sink log directory', () => {
  beforeEach(() => {
    vi.resetModules();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-agent-logger-'));
    process.env.CODE_AGENT_LOG_DIR = join(tempRoot, 'runtime-logs');
    process.env.CODE_AGENT_DATA_DIR = join(tempRoot, 'user-data');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogDir === undefined) delete process.env.CODE_AGENT_LOG_DIR;
    else process.env.CODE_AGENT_LOG_DIR = originalLogDir;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it('uses CODE_AGENT_LOG_DIR for local runtime logs', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createLogger, getCurrentLogFilePath } = await import('../../../../src/host/services/infra/logger');
    const logger = createLogger('LoggerLogDirTest');
    const logFile = getCurrentLogFilePath();

    logger.info('log-dir-override-smoke');
    logger.info('second-log-entry');
    await logger.dispose();

    expect(logFile.startsWith(process.env.CODE_AGENT_LOG_DIR!)).toBe(true);
    const sinkPathReports = consoleError.mock.calls.filter(
      ([message]) => message === `[Logger] file sink → ${logFile}`,
    );
    expect(sinkPathReports).toHaveLength(1);
    const content = await waitForLogFile(logFile);
    expect(content).toContain('LoggerLogDirTest');
    expect(content).toContain('log-dir-override-smoke');
  });

  it('writes lane and active correlation without inventing startup identifiers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createLogger, getCurrentLogFilePath } = await import('../../../../src/host/services/infra/logger');
    const {
      createChildRunTraceContext,
      createRunTraceContext,
      withRunTraceContext,
    } = await import('../../../../src/host/telemetry/runTraceContext');
    const logger = createLogger('MCPLoggerTest', { lane: 'mcp' });
    const run = createRunTraceContext({
      runId: 'run-logger',
      sessionId: 'session-logger',
      attempt: 1,
      ownerEpoch: 1,
      engine: 'native',
      workspace: '/tmp/logger',
      processInstanceId: 'process-logger',
    });

    logger.info('startup-without-correlation');
    const turn = createChildRunTraceContext(run, { turnId: 'turn-logger' });
    await withRunTraceContext(turn, async () => {
      logger.info('turn-with-correlation');
    });
    await logger.dispose();

    const content = await waitForLogFile(getCurrentLogFilePath(), 'turn-with-correlation');
    const lines = content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const startup = lines.find((line) => line.message === 'startup-without-correlation');
    const correlated = lines.find((line) => line.message === 'turn-with-correlation');
    expect(startup).toMatchObject({ lane: 'mcp' });
    expect(startup).not.toHaveProperty('sessionId');
    expect(startup).not.toHaveProperty('turnId');
    expect(correlated).toMatchObject({
      lane: 'mcp',
      runId: 'run-logger',
      sessionId: 'session-logger',
      turnId: 'turn-logger',
      traceId: run.traceId,
    });
    expect(correlated).not.toHaveProperty('toolCallId');
  });
});
