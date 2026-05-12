import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const originalEnv = { ...process.env };

async function loadModule() {
  vi.resetModules();
  return import('../../../../src/main/services/infra/shellEnvironment');
}

describe('shellEnvironment', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
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

    const { loadShellEnvironment, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();
    const diagnostics = getShellPathDiagnostics();

    expect(execSyncMock).toHaveBeenCalledWith("/bin/zsh -i -l -c 'env'", expect.any(Object));
    expect(diagnostics.source).toBe('captured');
    expect(diagnostics.path).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(diagnostics.degraded).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(diagnostics)).not.toContain('hidden');
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
