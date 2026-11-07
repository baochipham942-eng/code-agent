import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJsonPath = path.join(repoRoot, 'package.json');

// 场景：package.json 的 dev:cleanup（npm run dev 每次先跑它）曾用
//   lsof -ti:5173 -ti:8180 | xargs kill -9
// 缺 -sTCP:LISTEN，lsof 会把「merely 连着端口的进程」（开着 localhost:5173/8180
// 页面的浏览器 tab、调试器等 ESTABLISHED 连接）一并 SIGKILL——FB-553 / #2765 同形状。
// 本测试把脚本里的两个端口字面量换成测试自己 spawn 的临时端口（子 node 进程
// listen(0) 后向 stdout 报端口），用 bash -c 真跑改写后的命令：
//   listenerA/listenerB —— 5173/8180 的替身（LISTEN）→ 必须死
//   client —— 对 listenerA 持有 ESTABLISHED 连接的进程 → 必须活着
//   decoy —— 第三个端口上的无关 listener → 必须活着
// 脚本若退回「无 -sTCP:LISTEN 的 lsof」（反向变异）→ client 被 SIGKILL，测试红。
// 端口一律用临时端口替换后才执行，绝不碰真实 5173/8180，也绝不杀任何预存进程。

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

async function startListener(scriptPath: string): Promise<{ proc: Tracked; port: number }> {
  const proc = startNode([scriptPath]);
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

function readCleanupScript(): string {
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = parsed.scripts?.['dev:cleanup'];
  expect(script, 'package.json 缺 dev:cleanup 脚本').toBeTruthy();
  // 两个端口都必须还在清——不许悄悄收窄清理范围
  expect(script, String(script)).toContain('5173');
  expect(script, String(script)).toContain('8180');
  return script as string;
}

interface Scenario {
  listenerA: { proc: Tracked; port: number };
  listenerB: { proc: Tracked; port: number };
  decoy: { proc: Tracked; port: number };
  client: Tracked;
}

async function runScenario(): Promise<Scenario> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dev-cleanup-'));
  tempRoots.push(root);
  const listenerScript = path.join(root, 'tcp-listener.cjs');
  const clientScript = path.join(root, 'tcp-client.cjs');
  fs.writeFileSync(listenerScript, SERVER_SCRIPT);
  fs.writeFileSync(clientScript, CLIENT_SCRIPT);

  const listenerA = await startListener(listenerScript);
  const listenerB = await startListener(listenerScript);
  const decoy = await startListener(listenerScript);
  const client = await startClient(clientScript, listenerA.port);

  // 安全闸：临时端口绝不许落在真实端口上（listen(0) 取临时段，理论不可能，fail-closed）
  for (const { port } of [listenerA, listenerB, decoy]) {
    expect([5173, 8180], `临时端口撞上真实端口 ${port}`).not.toContain(port);
  }

  // 前置 sanity：本机 lsof 多个 -i 加 -sTCP:LISTEN 必须把两个 listener 都识别出来，
  // 且 ESTABLISHED client 与第三端口 decoy 都不在名单里
  const pre = spawnSync('lsof', ['-ti', `:${listenerA.port}`, '-ti', `:${listenerB.port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  const prePids = (pre.stdout ?? '').trim().split('\n').filter(Boolean).sort();
  expect(pre.status, pre.stderr ?? '').toBe(0);
  expect(prePids).toEqual(
    [String(listenerA.proc.child.pid), String(listenerB.proc.child.pid)].sort(),
  );

  return { listenerA, listenerB, decoy, client };
}

describe('package.json dev:cleanup 只杀 5173/8180 的 LISTEN（#2765 收尾）', () => {
  it('两个端口的 listener 死、ESTABLISHED client 与无关 decoy 存活', async () => {
    const script = readCleanupScript();
    const scenario = await runScenario();

    const rewritten = script
      .replaceAll('5173', String(scenario.listenerA.port))
      .replaceAll('8180', String(scenario.listenerB.port));
    expect(rewritten, '端口替换必须彻底，绝不碰真实 5173/8180').not.toContain('5173');
    expect(rewritten).not.toContain('8180');

    const result = spawnSync('bash', ['-c', rewritten], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    await waitFor(
      '两个端口的 listener 被 kill',
      () => hasExited(scenario.listenerA.proc.child) && hasExited(scenario.listenerB.proc.child),
    );
    // 留 300ms：若 lsof 误把 client 列进名单，误杀要有机会显形
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      hasExited(scenario.client.child),
      `merely 连着端口的客户端不该被 SIGKILL：${scenario.client.text()}`,
    ).toBe(false);
    expect(
      hasExited(scenario.decoy.proc.child),
      `第三个端口上的无关 listener 不该被杀：${scenario.decoy.proc.text()}`,
    ).toBe(false);
  }, 60_000);
});
