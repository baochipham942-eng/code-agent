import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalLogDir = process.env.CODE_AGENT_LOG_DIR;
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
let tempRoot: string | null = null;

async function waitForLogFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const content = readFileSync(filePath, 'utf8');
      if (content.includes('log-dir-override-smoke')) return content;
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
    if (originalLogDir === undefined) delete process.env.CODE_AGENT_LOG_DIR;
    else process.env.CODE_AGENT_LOG_DIR = originalLogDir;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it('uses CODE_AGENT_LOG_DIR for local runtime logs', async () => {
    const { createLogger, getCurrentLogFilePath } = await import('../../../../src/host/services/infra/logger');
    const logger = createLogger('LoggerLogDirTest');
    const logFile = getCurrentLogFilePath();

    logger.info('log-dir-override-smoke');
    await logger.dispose();

    expect(logFile.startsWith(process.env.CODE_AGENT_LOG_DIR!)).toBe(true);
    const content = await waitForLogFile(logFile);
    expect(content).toContain('LoggerLogDirTest');
    expect(content).toContain('log-dir-override-smoke');
  });
});
