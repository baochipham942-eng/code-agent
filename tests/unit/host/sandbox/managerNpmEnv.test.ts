import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBubblewrap } from '../../../../src/host/sandbox/bubblewrap';
import { SandboxManager } from '../../../../src/host/sandbox/manager';
import { getSeatbelt } from '../../../../src/host/sandbox/seatbelt';

function assertNpmEnvironment(customEnv: Record<string, string> | undefined): string {
  const userConfig = customEnv?.npm_config_userconfig;
  expect(userConfig).toMatch(/neo-npm-[^/]+\/npmrc$/);
  const npmHome = path.dirname(userConfig!);
  expect(npmHome.startsWith(path.join(os.tmpdir(), 'neo-npm-'))).toBe(true);

  expect(customEnv).toEqual({
    npm_config_userconfig: path.join(npmHome, 'npmrc'),
    npm_config_cache: path.join(npmHome, 'cache'),
    npm_config_logs_dir: path.join(npmHome, 'logs'),
    npm_config_update_notifier: 'false',
  });
  expect(fs.statSync(npmHome).mode & 0o777).toBe(0o700);
  expect(fs.readFileSync(path.join(npmHome, 'npmrc'), 'utf8')).toBe('');
  expect(fs.statSync(path.join(npmHome, 'cache')).isDirectory()).toBe(true);
  expect(fs.statSync(path.join(npmHome, 'logs')).isDirectory()).toBe(true);

  return npmHome;
}

function requireConfig<T>(config: T | undefined): T {
  if (!config) throw new Error('sandbox adapter did not receive a config');
  return config;
}

describe('sandbox npm environment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['development', 'full'] as const)('%s preset stays side-effect free', (preset) => {
    const config = SandboxManager.createPreset(preset);
    expect(config.customEnv).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('seatbelt wrap keeps the approved command unchanged and cleanup removes npmHome', () => {
    const seatbelt = getSeatbelt();
    vi.spyOn(seatbelt, 'checkAvailability').mockReturnValue({ available: true });
    const underlyingCleanup = vi.fn();
    const wrapSpy = vi.spyOn(seatbelt, 'wrapCommand').mockReturnValue({
      command: 'wrapped-seatbelt-command',
      cleanup: underlyingCleanup,
    });
    const manager = new SandboxManager();
    const approvedCommand = 'exec npm config get userconfig';
    const wrapped = manager.wrapCommand(approvedCommand, { workingDirectory: process.cwd() });
    const [receivedCommand, maybeConfig] = wrapSpy.mock.calls[0];
    const config = requireConfig(maybeConfig);
    const npmHome = assertNpmEnvironment(config.customEnv);

    expect(receivedCommand).toBe(approvedCommand);
    expect(config.writePaths).toContain(npmHome);
    expect(wrapped.command).toBe('wrapped-seatbelt-command');
    wrapped.cleanup();
    expect(underlyingCleanup).toHaveBeenCalledOnce();
    expect(fs.existsSync(npmHome), npmHome).toBe(false);
  });

  it.runIf(process.platform === 'linux')('bubblewrap binds npmHome, keeps the approved command unchanged, and cleans up', () => {
    const bubblewrap = getBubblewrap();
    vi.spyOn(bubblewrap, 'checkAvailability').mockReturnValue({ available: true });
    const underlyingCleanup = vi.fn();
    const wrapSpy = vi.spyOn(bubblewrap, 'wrapCommand').mockReturnValue({
      command: 'wrapped-bubblewrap-command',
      cleanup: underlyingCleanup,
    });
    const manager = new SandboxManager();
    const approvedCommand = 'exec npm config get userconfig';
    const wrapped = manager.wrapCommand(approvedCommand, { workingDirectory: process.cwd() });
    const [receivedCommand, maybeConfig] = wrapSpy.mock.calls[0];
    const config = requireConfig(maybeConfig);
    const npmHome = assertNpmEnvironment(config.customEnv);

    expect(receivedCommand).toBe(approvedCommand);
    expect(config.readWritePaths).toContain(npmHome);
    expect(wrapped.command).toBe('wrapped-bubblewrap-command');
    wrapped.cleanup();
    expect(underlyingCleanup).toHaveBeenCalledOnce();
    expect(fs.existsSync(npmHome)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('seatbelt execute cleans npmHome in the host finally path', async () => {
    const seatbelt = getSeatbelt();
    vi.spyOn(seatbelt, 'checkAvailability').mockReturnValue({ available: true });
    let npmHome = '';
    const executeSpy = vi.spyOn(seatbelt, 'execute').mockImplementation(async (command, config) => {
      expect(command).toBe('exec npm config get userconfig');
      npmHome = assertNpmEnvironment(requireConfig(config).customEnv);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sandboxed: true };
    });
    const manager = new SandboxManager();

    await manager.execute('exec npm config get userconfig', { workingDirectory: process.cwd() });

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(fs.existsSync(npmHome)).toBe(false);
  });

  it.runIf(process.platform === 'linux')('bubblewrap execute binds npmHome and cleans it in the host finally path', async () => {
    const bubblewrap = getBubblewrap();
    vi.spyOn(bubblewrap, 'checkAvailability').mockReturnValue({ available: true });
    let npmHome = '';
    const executeSpy = vi.spyOn(bubblewrap, 'execute').mockImplementation(async (command, config) => {
      expect(command).toBe('exec npm config get userconfig');
      const requiredConfig = requireConfig(config);
      npmHome = assertNpmEnvironment(requiredConfig.customEnv);
      expect(requiredConfig.readWritePaths).toContain(npmHome);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sandboxed: true };
    });
    const manager = new SandboxManager();

    await manager.execute('exec npm config get userconfig', { workingDirectory: process.cwd() });

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(fs.existsSync(npmHome)).toBe(false);
  });
});
