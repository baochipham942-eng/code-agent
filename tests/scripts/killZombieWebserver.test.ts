import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installScript = path.join(repoRoot, 'scripts', 'tauri-install.sh');
const publishScript = path.join(repoRoot, 'scripts', 'publish-release.sh');

// 场景复刻 FB-553 的形状（install/release 脚本误杀别的会话的 webServer）：
//   decoy  —— 别的会话的 webServer.cjs（Dev 槽 / verify-slotless），进程名相同、端口不同 → 必须活着
//   zombie —— 占住 WEB_PORT 的前次残留 webServer.cjs → 必须死
//   client —— merely 连着 WEB_PORT 的 TCP 客户端（开着 localhost 页面的浏览器 tab）→ 必须活着
// 脚本若退回「按进程名 pkill -f webServer.cjs」→ decoy 死；若退回「无 -sTCP:LISTEN 的 lsof」→ client 死。
// 两个被测函数体按任务书口径用 sed 从脚本原文抽出，在子 bash 里 source 后真跑。

const SERVER_SCRIPT = `const net = require('node:net');
const s = net.createServer(() => {});
s.on('error', (err) => { console.error('server error', err.message); process.exit(1); });
s.listen(0, '127.0.0.1', () => { console.log('LISTENING ' + s.address().port); });
`;

const CLIENT_SCRIPT = `const net = require('node:net');
const port = Number(process.argv[2]);
const sock = net.connect({ port, host: '127.0.0.1' }, () => { console.log('READY'); });
sock.on('error', () => {});
// 服务端被杀后 socket 会关，靠定时器留在进程表里（模拟浏览器 tab 不断开用户进程）
setInterval(() => {}, 5000);
`;

// 安全闸：万一被抽出的函数体里又冒出按进程名的 pkill（回归/反向变异），
// 真信号只会打到本测试自己 spawn 的直连子进程（KZ_ROOT_PID 的孩子），
// 绝不带伤共享机上其他会话真在跑的 webServer.cjs。
const PKILL_SHIM = `#!/bin/bash
if [ -z "\${KZ_ROOT_PID:-}" ] || [ ! -x /usr/bin/pkill ]; then
  echo "pkill shim refusing: KZ_ROOT_PID missing" >&2
  exit 1
fi
exec /usr/bin/pkill -P "$KZ_ROOT_PID" "$@"
`;

const tempRoots: string[] = [];
const spawnedChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (!hasExited(child)) child.kill('SIGKILL');
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

interface Tracked {
  child: ChildProcess;
  text(): string;
}

function startNode(args: string[]): Tracked {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  spawnedChildren.push(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      output += chunk;
    });
  }
  return { child, text: () => output };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function startWebServer(scriptPath: string): Promise<{ proc: Tracked; port: number }> {
  const proc = startNode([scriptPath, '0']);
  await waitFor(`LISTENING from ${scriptPath}`, () => /LISTENING (\d+)/.test(proc.text()));
  const port = Number(proc.text().match(/LISTENING (\d+)/)?.[1]);
  expect(Number.isInteger(port) && port > 0, proc.text()).toBe(true);
  return { proc, port };
}

async function startClient(scriptPath: string, port: number): Promise<Tracked> {
  const proc = startNode([scriptPath, String(port)]);
  await waitFor(`client READY on ${port}`, () => proc.text().includes('READY'));
  return proc;
}

function shellQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function buildHarness(root: string, fnName: string, scriptPath: string, webPort: number): string {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'pkill');
  fs.writeFileSync(shimPath, PKILL_SHIM);
  fs.chmodSync(shimPath, 0o755);

  const fnFile = path.join(root, `${fnName}.extracted.sh`);
  const sed = spawnSync('sed', ['-n', `/^${fnName}() {/,/^}/p`, scriptPath], { encoding: 'utf8' });
  expect(sed.status, sed.stderr ?? '').toBe(0);
  expect(sed.stdout, `${fnName}() 缺失于 ${scriptPath}`).toContain(`${fnName}() {`);
  fs.writeFileSync(fnFile, sed.stdout);

  const harnessPath = path.join(root, `${fnName}.harness.sh`);
  fs.writeFileSync(
    harnessPath,
    [
      '#!/bin/bash',
      'set -u',
      `export PATH=${shellQuote(binDir)}:$PATH`,
      `export KZ_ROOT_PID=${process.pid}`,
      'log() { echo "[stub-log] $*"; }',
      'open() { echo "[stub-open] $*"; }',
      'APP_NAME="Agent Neo"',
      'DO_INSTALL=1',
      `WEB_PORT=${webPort}`,
      `source ${shellQuote(fnFile)}`,
      fnName,
      '',
    ].join('\n'),
  );
  fs.chmodSync(harnessPath, 0o755);
  return harnessPath;
}

interface Scenario {
  decoy: Tracked;
  zombie: Tracked;
  client: Tracked;
  zombiePort: number;
  run: { status: number | null; stdout: string; stderr: string };
}

async function runScenario(fnName: string, scriptPath: string): Promise<Scenario> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `neo-kill-zombie-${fnName}-`));
  tempRoots.push(root);
  for (const dir of ['decoy', 'zombie', 'client']) {
    fs.mkdirSync(path.join(root, dir));
  }

  const decoyScript = path.join(root, 'decoy', 'webServer.cjs');
  const zombieScript = path.join(root, 'zombie', 'webServer.cjs');
  const clientScript = path.join(root, 'client', 'tcp-client.cjs');
  fs.writeFileSync(decoyScript, SERVER_SCRIPT);
  fs.writeFileSync(zombieScript, SERVER_SCRIPT);
  fs.writeFileSync(clientScript, CLIENT_SCRIPT);

  const decoy = await startWebServer(decoyScript);
  const zombie = await startWebServer(zombieScript);
  const client = await startClient(clientScript, zombie.port);

  // 前置 sanity：修复后的 lsof 形状必须把 zombie 识别为 WEB_PORT 上唯一的 listener
  const listener = spawnSync('lsof', ['-ti', `tcp:${zombie.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  expect(
    (listener.stdout ?? '').trim().split('\n').filter(Boolean),
    listener.stderr ?? '',
  ).toEqual([String(zombie.proc.child.pid)]);

  const harness = buildHarness(root, fnName, scriptPath, zombie.port);
  const result = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 30_000 });
  const run = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  return { decoy: decoy.proc, zombie: zombie.proc, client, zombiePort: zombie.port, run };
}

async function assertOnlyListenerKilled(scenario: Scenario): Promise<void> {
  expect(scenario.run.status, `${scenario.run.stdout}\n${scenario.run.stderr}`).toBe(0);
  await waitFor('WEB_PORT zombie 被 kill', () => hasExited(scenario.zombie.child));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    hasExited(scenario.decoy.child),
    `别会话的同名 webServer.cjs 不该被杀：${scenario.decoy.text()}`,
  ).toBe(false);
  expect(
    hasExited(scenario.client.child),
    'merely 连着 WEB_PORT 的客户端不该被杀',
  ).toBe(false);
}

describe('install/release 脚本只杀 WEB_PORT 的 listener（FB-553）', () => {
  it('tauri-install.sh kill_zombie_webserver：同名 decoy 存活、WEB_PORT zombie 死、已连接 client 存活', async () => {
    const scenario = await runScenario('kill_zombie_webserver', installScript);
    await assertOnlyListenerKilled(scenario);
    expect(scenario.run.stdout).toContain(`killing zombie processes on port ${scenario.zombiePort}`);
  }, 60_000);

  it('publish-release.sh launch_app：同名 decoy 存活、WEB_PORT zombie 死、已连接 client 存活', async () => {
    const scenario = await runScenario('launch_app', publishScript);
    await assertOnlyListenerKilled(scenario);
    expect(scenario.run.stdout).toContain(`[stub-log] step 7: kill zombie webServer + launch app`);
    expect(scenario.run.stdout).toContain(`killing process on :${scenario.zombiePort}`);
    expect(scenario.run.stdout).toContain('[stub-open] -n');
  }, 60_000);

  it('tauri-install.sh 的 app 关闭 pkill 锚定安装路径，不按裸名字杀 Dev 槽', () => {
    const script = fs.readFileSync(installScript, 'utf8');
    // 只看真正的 pkill 命令行（注释不算）："Agent Neo" 是 "Agent Neo Dev"/"Agent Neo Dev 2"
    // 的路径前缀，裸名字 pkill 会连坐正在验证的 Dev 槽（FB-553）
    const pkillLines = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('pkill '));
    expect(pkillLines).toEqual([
      'pkill -f "$INSTALLED_APP/Contents/MacOS/" 2>/dev/null || true',
      'pkill -f "$APPLICATIONS_DIR/$LEGACY_APP_NAME.app/Contents/MacOS/" 2>/dev/null || true',
    ]);
  });
});
