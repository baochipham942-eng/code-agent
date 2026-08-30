import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalLogDir = process.env.CODE_AGENT_LOG_DIR;
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
const originalCliMode = process.env.CODE_AGENT_CLI_MODE;
const originalWebMode = process.env.CODE_AGENT_WEB_MODE;
const originalDebug = process.env.DEBUG;
let tempRoot: string | null = null;

async function waitForLogFile(filePath: string, needle: string): Promise<string> {
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

describe('logger stderr sink mute (Ink TUI 拥有屏幕期间)', () => {
  beforeEach(() => {
    vi.resetModules();
    tempRoot = mkdtempSync(join(tmpdir(), 'code-agent-logger-mute-'));
    process.env.CODE_AGENT_LOG_DIR = join(tempRoot, 'runtime-logs');
    process.env.CODE_AGENT_DATA_DIR = join(tempRoot, 'user-data');
    // 走 CLI-only 紧凑单行分支（Ink 场景）
    process.env.CODE_AGENT_CLI_MODE = 'true';
    delete process.env.CODE_AGENT_WEB_MODE;
    delete process.env.DEBUG;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogDir === undefined) delete process.env.CODE_AGENT_LOG_DIR;
    else process.env.CODE_AGENT_LOG_DIR = originalLogDir;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    if (originalCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
    else process.env.CODE_AGENT_CLI_MODE = originalCliMode;
    if (originalWebMode === undefined) delete process.env.CODE_AGENT_WEB_MODE;
    else process.env.CODE_AGENT_WEB_MODE = originalWebMode;
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it('muted: ERROR 不写 stderr，但文件持久化不受影响', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createLogger, getCurrentLogFilePath, setStderrSinkMuted } = await import(
      '../../../../src/host/services/infra/logger'
    );
    const logger = createLogger('MuteTest');

    setStderrSinkMuted(true);
    logger.error('muted-error-line');
    setStderrSinkMuted(false);
    await logger.dispose();

    const errorLines = consoleError.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('muted-error-line'),
    );
    expect(errorLines).toHaveLength(0);

    const content = await waitForLogFile(getCurrentLogFilePath(), 'muted-error-line');
    expect(content).toContain('muted-error-line');
  });

  it('unmuted: ERROR 恢复 stderr 紧凑单行，且 ak_ 密钥已脱敏', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createLogger, setStderrSinkMuted } = await import(
      '../../../../src/host/services/infra/logger'
    );
    const logger = createLogger('UnmuteTest');
    const akKey = `ak_${'g'.repeat(32)}`;

    setStderrSinkMuted(true);
    setStderrSinkMuted(false);
    logger.error(`无效的AppId: ${akKey}`);
    await logger.dispose();

    const errorLines = consoleError.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('无效的AppId'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).not.toContain(akKey);
    expect(errorLines[0]).toContain('ak_***REDACTED***');
  });
});
