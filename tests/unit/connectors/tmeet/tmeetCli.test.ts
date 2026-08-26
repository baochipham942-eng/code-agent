import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ptySpawnMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('node-pty', async () => {
  const { spawn: spawnChild } = await import('node:child_process');
  return {
    spawn: (executable: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      ptySpawnMock(executable, args, options);
      const child = spawnChild(executable, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const dataListeners: Array<(chunk: string) => void> = [];
      const exitListeners: Array<(event: { exitCode: number; signal: number }) => void> = [];
      child.stdout.on('data', (chunk: Buffer) => dataListeners.forEach((listener) => listener(chunk.toString('utf8'))));
      child.stderr.on('data', (chunk: Buffer) => dataListeners.forEach((listener) => listener(chunk.toString('utf8'))));
      child.on('close', (code) => exitListeners.forEach((listener) => listener({ exitCode: code ?? 1, signal: 0 })));
      return {
        pid: child.pid ?? 0,
        onData: (listener: (chunk: string) => void) => { dataListeners.push(listener); },
        onExit: (listener: (event: { exitCode: number; signal: number }) => void) => { exitListeners.push(listener); },
        kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); },
      };
    },
  };
});
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
  }),
}));
import { createTmeetCliDriver } from '../../../../src/host/connectors/tmeet/tmeetCli';

const roots: string[] = [];

const FAKE_TMEET = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args,
  agent: process.env.TMEET_AGENT,
  model: process.env.TMEET_MODEL,
  openclaw: process.env.OPENCLAW_HOME,
  hermes: process.env.HERMES_HOME,
}) + '\\n');
if (args[0] === 'auth' && args[1] === 'login') {
  if (mode === 'login-already') {
    fs.writeFileSync(process.env.FAKE_CREDENTIAL, 'connected');
    process.stderr.write("execute failed: user has been login, please use 'tmeet cmd [flags]' to use\\n");
    process.exit(1);
  }
  process.stdout.write('Open https://meeting.tencent.com/oauth2/authorize?code=fake to authorize\\n');
  setTimeout(() => {
    fs.writeFileSync(process.env.FAKE_CREDENTIAL, 'connected');
    process.exit(0);
  }, 25);
} else if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'status-fail') {
    process.stderr.write('status unavailable\\n');
    process.exit(1);
  }
  process.stdout.write(fs.existsSync(process.env.FAKE_CREDENTIAL)
    ? 'Logged in. Token expires at 2099-01-01.\\n'
    : "Not logged in. Please use 'tmeet auth login' to authenticate.\\n");
  process.exit(0);
} else if (args[0] === 'auth' && args[1] === 'logout') {
  if (fs.existsSync(process.env.FAKE_CREDENTIAL)) fs.unlinkSync(process.env.FAKE_CREDENTIAL);
  setTimeout(() => process.exit(0), 10);
} else {
  process.exit(2);
}
`;

afterEach(async () => {
  ptySpawnMock.mockClear();
  loggerWarnMock.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  modelName = 'gpt-test',
  mode = 'normal',
  statusOptions: { statusTimeoutMs?: number } = {},
) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'neo-tmeet-cli-'));
  roots.push(dataDir);
  const packageDir = path.join(dataDir, 'tmeet', 'node_modules', '@tencentcloud', 'tmeet');
  const binaryPath = path.join(packageDir, 'scripts', 'tmeet.js');
  const logPath = path.join(dataDir, 'calls.ndjson');
  const credentialPath = path.join(dataDir, 'credential');
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: 'v1.0.15' }));
  await writeFile(binaryPath, FAKE_TMEET);
  await chmod(binaryPath, 0o755);
  const driver = createTmeetCliDriver({
    dataDir,
    modelName,
    timeoutMs: 10_000,
    statusCacheTtlMs: 0,
    ...statusOptions,
    env: {
      ...process.env,
      FAKE_LOG: logPath,
      FAKE_CREDENTIAL: credentialPath,
      FAKE_MODE: mode,
      OPENCLAW_HOME: '/should-not-leak',
      HERMES_HOME: '/should-not-leak',
    },
  });
  return { driver, logPath, credentialPath };
}

async function calls(logPath: string): Promise<Array<{
  args: string[];
  agent?: string;
  model?: string;
  openclaw?: string;
  hermes?: string;
}>> {
  const content = await readFile(logPath, 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line));
}

describe('Tencent Meeting tmeet CLI driver', () => {
  it('runs the blocking login in a PTY, opens its URL, and exposes one connection step', async () => {
    const { driver, logPath } = await fixture();
    const opened: string[] = [];
    const steps: number[] = [];

    await driver.connect((url) => { opened.push(url); }, (step) => { steps.push(step); });

    expect(opened).toEqual(['https://meeting.tencent.com/oauth2/authorize?code=fake']);
    expect(steps).toEqual([1]);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    const recorded = await calls(logPath);
    expect(recorded.map((call) => call.args)).toEqual([
      ['auth', 'status'],
      ['auth', 'login', '--no-browser'],
      ['auth', 'status'],
    ]);
    expect(recorded.every((call) => call.agent === 'AgentNeo' && call.model === 'gpt-test')).toBe(true);
    expect(recorded.every((call) => call.openclaw === undefined && call.hermes === undefined)).toBe(true);
  });

  it('matches only the documented Logged in status text', async () => {
    const { driver, credentialPath } = await fixture();
    await expect(driver.status()).resolves.toEqual({ connected: false, identity: 'none' });

    await writeFile(credentialPath, 'connected');
    await expect(driver.status()).resolves.toEqual({ connected: true, identity: 'user' });
  });

  it('marks a failed status probe as stale and records the concrete warning', async () => {
    const { driver } = await fixture('gpt-test', 'status-fail');

    await expect(driver.status()).resolves.toEqual({
      connected: false,
      identity: 'none',
      stale: true,
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'CLI connector status probe failed',
      expect.objectContaining({
        providerId: 'tmeet',
        errorName: 'CliConnectorCommandError',
        cachedStatusAvailable: false,
      }),
    );
  });

  it('returns success without starting a PTY when status is already connected', async () => {
    const { driver, credentialPath, logPath } = await fixture();
    await writeFile(credentialPath, 'connected');

    await expect(driver.connect(() => {})).resolves.toEqual({ alreadyConnected: true });

    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect((await calls(logPath)).map((call) => call.args)).toEqual([['auth', 'status']]);
  });

  it('accepts the descriptor-declared already-login output only after status confirms it', async () => {
    const { driver, logPath } = await fixture('gpt-test', 'login-already');
    const opened: string[] = [];

    await expect(driver.connect((url) => { opened.push(url); }))
      .resolves.toEqual({ alreadyConnected: true });

    expect(opened).toEqual([]);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    expect((await calls(logPath)).map((call) => call.args)).toEqual([
      ['auth', 'status'],
      ['auth', 'login', '--no-browser'],
      ['auth', 'status'],
    ]);
  });

  it('coalesces repeated connect requests onto one PTY login', async () => {
    const { driver } = await fixture();

    const first = driver.connect(() => {});
    const second = driver.connect(() => {});
    await expect(Promise.all([first, second])).resolves.toEqual([
      { alreadyConnected: false },
      { alreadyConnected: false },
    ]);

    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
  });

  it('logs out without removing the installed CLI', async () => {
    const { driver, logPath, credentialPath } = await fixture();
    await writeFile(credentialPath, 'connected');

    await driver.disconnect();

    expect((await calls(logPath)).map((call) => call.args)).toEqual([['auth', 'logout']]);
    await expect(driver.status()).resolves.toEqual({ connected: false, identity: 'none' });
  });

  it('pins installation to 1.0.15 under the Neo tmeet data directory', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'neo-tmeet-install-'));
    roots.push(dataDir);
    const npmPath = path.join(dataDir, 'fake-npm');
    const npmLog = path.join(dataDir, 'npm-args.json');
    await writeFile(npmPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args));
const prefix = args[args.indexOf('--prefix') + 1];
const pkg = path.join(prefix, 'node_modules', '@tencentcloud', 'tmeet');
fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: 'v1.0.15' }));
fs.writeFileSync(path.join(pkg, 'scripts', 'tmeet.js'), '');
fs.chmodSync(path.join(pkg, 'scripts', 'tmeet.js'), 0o755);
`);
    await chmod(npmPath, 0o755);
    const driver = createTmeetCliDriver({
      dataDir,
      npmExecutable: npmPath,
      env: { ...process.env, FAKE_NPM_LOG: npmLog },
    });

    await driver.ensureInstalled();

    expect(JSON.parse(await readFile(npmLog, 'utf8'))).toEqual([
      'install', '--prefix', path.join(dataDir, 'tmeet'), '@tencentcloud/tmeet@1.0.15',
    ]);
  });
});
