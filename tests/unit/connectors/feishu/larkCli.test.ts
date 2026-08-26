import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCachedStatus } from '../../../../src/host/connectors/cli/cliConnector';
import { createLarkCliDriver } from '../../../../src/host/connectors/feishu/larkCli';

const roots: string[] = [];

const FAKE_LARK_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args,
  openclaw: process.env.OPENCLAW_HOME,
  hermes: process.env.HERMES_HOME,
}) + '\\n');
const mode = process.env.FAKE_MODE;
if (args[0] === 'config' && args[1] === 'show') {
  process.exit(mode === 'new-profile' ? 1 : 0);
}
if (args[0] === 'config' && args[1] === 'init') {
  process.stdout.write('请打开 https://open.feishu.cn/cli/setup/fake-code 完成创建\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'logout') process.exit(0);
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_STATUS_HANG && fs.existsSync(process.env.FAKE_STATUS_HANG)) {
    setInterval(() => {}, 1000);
  } else {
    if (mode === 'status-fail') process.exit(1);
    process.stdout.write(JSON.stringify({
      identities: { user: { available: true, openId: 'ou_fake', userName: 'Neo User', tenantName: 'Neo Corp' } },
      identity: 'user',
    }));
    process.exit(0);
  }
} else if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
  if (mode === 'admin-error') {
    process.stderr.write(JSON.stringify({ error: { code: 20027, message: 'scope denied by tenant admin' } }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    device_code: 'device-fake',
    verification_url: 'https://open.feishu.cn/device',
    expires_in: 300,
  }));
  process.exit(0);
} else if (args[0] === 'auth' && args[1] === 'login' && args.includes('--device-code')) {
  if (mode === 'timeout') setInterval(() => {}, 1000);
  else process.exit(0);
} else {
  process.exit(2);
}
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mode: string, timeoutMs = 10_000, statusOptions: {
  statusCacheTtlMs?: number;
  statusTimeoutMs?: number;
  now?: () => number;
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'neo-lark-cli-'));
  roots.push(dataDir);
  const packageDir = path.join(dataDir, 'lark-cli', 'node_modules', '@larksuite', 'cli');
  const binaryPath = path.join(packageDir, 'bin', 'lark-cli');
  const logPath = path.join(dataDir, 'calls.ndjson');
  const statusHangPath = path.join(dataDir, 'status-hang');
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.89' }));
  await writeFile(binaryPath, FAKE_LARK_CLI);
  await chmod(binaryPath, 0o755);
  const driver = createLarkCliDriver({
    dataDir,
    timeoutMs,
    ...statusOptions,
    env: {
      ...process.env,
      FAKE_LOG: logPath,
      FAKE_MODE: mode,
      FAKE_STATUS_HANG: statusHangPath,
      OPENCLAW_HOME: '/should-not-leak',
      HERMES_HOME: '/should-not-leak',
    },
  });
  return { driver, logPath, statusHangPath };
}

async function calls(logPath: string): Promise<Array<{
  args: string[];
  openclaw?: string;
  hermes?: string;
}>> {
  const content = await readFile(logPath, 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line));
}

describe('Feishu lark-cli driver', () => {
  it('creates the isolated profile, opens both child-process URLs, and requests explicit scopes', async () => {
    const { driver, logPath } = await fixture('new-profile');
    const opened: string[] = [];
    const steps: number[] = [];

    await driver.connect((url) => { opened.push(url); }, (step) => { steps.push(step); });

    expect(steps).toEqual([1, 2]);
    expect(opened).toEqual([
      'https://open.feishu.cn/cli/setup/fake-code',
      'https://open.feishu.cn/device',
    ]);
    const recorded = await calls(logPath);
    expect(recorded.every((call) => call.openclaw === undefined && call.hermes === undefined)).toBe(true);
    expect(recorded.map((call) => call.args)).toEqual([
      ['config', 'show', '--profile', 'neo'],
      ['config', 'init', '--new', '--lang', 'zh', '--name', 'neo'],
      [
        'auth', 'login', '--no-wait', '--json',
        '--scope', 'offline_access im:message im:message.send_as_user',
        '--profile', 'neo',
      ],
      ['auth', 'login', '--device-code', 'device-fake', '--profile', 'neo'],
    ]);
  });

  it('uses an existing isolated profile without creating another app', async () => {
    const { driver, logPath } = await fixture('existing-profile');
    const opened: string[] = [];

    await driver.connect((url) => { opened.push(url); });

    expect(opened).toEqual(['https://open.feishu.cn/device']);
    expect((await calls(logPath)).map((call) => call.args[1])).not.toContain('init');
  });

  it('stops setup when the browser URL cannot be opened', async () => {
    const { driver } = await fixture('new-profile');

    await expect(driver.connect(() => Promise.reject(new Error('browser unavailable'))))
      .rejects.toThrow('Could not open the Feishu setup URL');
  });

  it('parses user status, preserves missing-install setup, and marks other failures unknown', async () => {
    const ready = await fixture('existing-profile');
    await expect(ready.driver.status()).resolves.toEqual({
      connected: true,
      identity: 'user',
      user: { openId: 'ou_fake', name: 'Neo User', tenantName: 'Neo Corp' },
    });

    const missing = createLarkCliDriver({
      dataDir: path.join(path.dirname(ready.logPath), 'missing'),
      timeoutMs: 100,
    });
    await expect(missing.status()).resolves.toEqual({ connected: false, identity: 'none' });

    const unconfigured = await fixture('status-fail');
    await expect(unconfigured.driver.status()).resolves.toEqual({
      connected: false,
      identity: 'none',
      stale: true,
    });
  });

  it('reuses status inside the TTL and refreshes after expiry', async () => {
    let now = 1_000;
    const { driver, logPath } = await fixture('existing-profile', 10_000, {
      statusCacheTtlMs: 30_000,
      now: () => now,
    });

    await driver.status();
    await driver.status();
    expect((await calls(logPath)).filter((call) => call.args[1] === 'status')).toHaveLength(1);

    now += 30_001;
    await driver.status();
    expect((await calls(logPath)).filter((call) => call.args[1] === 'status')).toHaveLength(2);
  });

  it('returns the last known status as stale when refresh times out', async () => {
    let now = 1_000;
    const { driver, logPath, statusHangPath } = await fixture('existing-profile', 10_000, {
      statusCacheTtlMs: 30_000,
      statusTimeoutMs: 4_000,
      now: () => now,
    });
    const known = await driver.status();
    expect(known.connected).toBe(true);

    now += 30_001;
    await writeFile(statusHangPath, '1');
    await expect(driver.status()).resolves.toEqual({ ...known, stale: true });
    expect(getCachedStatus('feishu')).toEqual({ ...known, stale: true });

    await driver.status();
    expect((await calls(logPath)).filter((call) => call.args[1] === 'status')).toHaveLength(2);
  });

  it('invalidates status after connect and disconnect actions', async () => {
    const { driver, logPath } = await fixture('existing-profile');

    await driver.status();
    await driver.connect(() => {});
    await driver.status();
    await driver.disconnect();
    await driver.status();

    expect((await calls(logPath)).filter((call) => call.args[1] === 'status')).toHaveLength(3);
  });

  it('logs out the Neo token without removing the lark-cli profile', async () => {
    const { driver, logPath } = await fixture('existing-profile');

    await driver.disconnect();

    expect((await calls(logPath)).map((call) => call.args)).toEqual([
      ['auth', 'logout', '--profile', 'neo'],
    ]);
  });

  it('turns tenant scope rejection into the approved administrator instruction', async () => {
    const { driver } = await fixture('admin-error');

    await expect(driver.connect(() => {})).rejects.toThrow('需联系企业应用管理员安装');
  });

  it('kills a stalled device-code poll at the OAuth flow deadline', async () => {
    const { driver } = await fixture('timeout', 50);

    await expect(driver.connect(() => {})).rejects.toThrow('timed out after 50ms');
  }, 1_000);

  it('pins installation to 1.0.89 under the Neo data directory', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'neo-lark-install-'));
    roots.push(dataDir);
    const npmPath = path.join(dataDir, 'fake-npm');
    const npmLog = path.join(dataDir, 'npm-args.json');
    await writeFile(npmPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args));
const prefix = args[args.indexOf('--prefix') + 1];
const pkg = path.join(prefix, 'node_modules', '@larksuite', 'cli');
fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.0.89' }));
fs.writeFileSync(path.join(pkg, 'bin', 'lark-cli'), '');
fs.chmodSync(path.join(pkg, 'bin', 'lark-cli'), 0o755);
`);
    await chmod(npmPath, 0o755);
    const driver = createLarkCliDriver({
      dataDir,
      npmExecutable: npmPath,
      env: { ...process.env, FAKE_NPM_LOG: npmLog },
    });

    await driver.ensureInstalled();

    expect(JSON.parse(await readFile(npmLog, 'utf8'))).toEqual([
      'install', '--prefix', path.join(dataDir, 'lark-cli'), '@larksuite/cli@1.0.89',
    ]);
  });
});
