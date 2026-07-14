import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execSync: execSyncMock,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const originalEnv = { ...process.env };
let tempDataDir: string;

function writeCache(input: {
  schemaVersion?: number;
  shell?: string;
  environment?: Record<string, string>;
} = {}): string {
  const cachePath = join(tempDataDir, 'cache', 'shell-environment.json');
  mkdirSync(join(tempDataDir, 'cache'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    schemaVersion: input.schemaVersion ?? 1,
    platform: process.platform,
    shell: input.shell ?? '/bin/zsh',
    capturedAt: '2026-07-14T00:00:00.000Z',
    environment: input.environment ?? { PATH: '/cached/bin:/usr/bin' },
  }));
  return cachePath;
}

async function loadModule() {
  vi.resetModules();
  return import('../../../../src/host/services/infra/shellEnvironment');
}

describe('shellEnvironment', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execFileMock.mockReset();
    process.env = { ...originalEnv };
    tempDataDir = mkdtempSync(join(tmpdir(), 'shell-environment-test-'));
    process.env.CODE_AGENT_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('adds common macOS CLI fallback paths when process PATH is degraded', async () => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;

    const { getShellPathDiagnostics } = await loadModule();
    const diagnostics = getShellPathDiagnostics();

    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.path.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/Library/Apple/usr/bin',
    ]);
  });

  it('keeps an existing non-degraded PATH unchanged', async () => {
    process.env.PATH = '/custom/bin:/usr/bin:/bin';

    const { getShellPathDiagnostics } = await loadModule();
    const diagnostics = getShellPathDiagnostics();

    expect(diagnostics.degraded).toBe(false);
    expect(diagnostics.fallbackApplied).toBe(false);
    expect(diagnostics.path).toBe('/custom/bin:/usr/bin:/bin');
  });

  it('skips shell capture only in pure CLI mode', async () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    delete process.env.CODE_AGENT_WEB_MODE;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

    const { loadShellEnvironment } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('captures login shell PATH in web mode even when CLI mode is set for native modules', async () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    execSyncMock.mockReturnValue('PATH=/opt/homebrew/bin:/usr/bin:/bin\nHOME=/Users/test\nSECRET_TOKEN=hidden\n');

    const { loadShellEnvironment, getShellEnvironmentValue, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();
    const diagnostics = getShellPathDiagnostics();

    expect(execSyncMock).toHaveBeenCalledWith("/bin/zsh -i -l -c 'env'", expect.any(Object));
    expect(diagnostics.source).toBe('captured');
    expect(diagnostics.path).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(diagnostics.degraded).toBe(false);
    expect(getShellEnvironmentValue('SECRET_TOKEN')).toBe('hidden');
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(diagnostics)).not.toContain('hidden');
    const cachePath = join(tempDataDir, 'cache', 'shell-environment.json');
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).environment.SECRET_TOKEN).toBe('hidden');
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it('uses a valid cache immediately and refreshes it in the background', async () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const cachePath = writeCache({
      environment: { PATH: '/cached/bin:/usr/bin', CACHE_ONLY: 'old' },
    });
    let refreshCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      refreshCallback = callback;
      return {};
    });

    const { loadShellEnvironment, getShellEnvironmentValue, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-i', '-l', '-c', 'env'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(getShellEnvironmentValue('CACHE_ONLY')).toBe('old');
    expect(getShellPathDiagnostics().path).toBe('/cached/bin:/usr/bin:/bin');

    refreshCallback?.(null, 'PATH=/fresh/bin:/usr/bin\nCACHE_ONLY=new\n', '');
    expect(getShellEnvironmentValue('CACHE_ONLY')).toBe('new');
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).environment.CACHE_ONLY).toBe('new');
  });

  it('invalidates an incompatible cache and preserves synchronous first-run capture', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    writeCache({ schemaVersion: 0 });
    execSyncMock.mockReturnValue('PATH=/captured/bin:/usr/bin\nSOURCE=fresh-capture\n');

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(getShellEnvironmentValue('SOURCE')).toBe('fresh-capture');
  });

  it('keeps cached values when the background refresh fails', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    writeCache({ environment: { PATH: '/cached/bin', KEEP_ME: 'yes' } });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('refresh failed'), '', '');
      return {};
    });

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(getShellEnvironmentValue('KEEP_ME')).toBe('yes');
  });

  it('uses fallback paths when shell capture fails and process PATH is degraded', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    execSyncMock.mockImplementation(() => {
      throw new Error('capture failed');
    });

    const { loadShellEnvironment, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();
    const diagnostics = getShellPathDiagnostics();

    expect(diagnostics.source).toBe('process');
    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.path).toContain('/opt/homebrew/bin');
    expect(diagnostics.path).toContain('/usr/local/bin');
  });
});
