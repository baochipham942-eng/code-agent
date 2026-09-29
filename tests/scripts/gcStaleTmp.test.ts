import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gcScript = path.join(repoRoot, 'scripts', 'gc-stale-tmp.mjs');

const TWO_DAYS_MS = 2 * 24 * 3_600_000;

interface Sandbox {
  root: string;
  staleFree: string;
  held: string;
  fresh: string;
  unrelated: string;
  npmCache: string;
  holder: ChildProcess;
}

const sandboxes: Sandbox[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    if (sandbox.holder.exitCode === null && !sandbox.holder.killed) sandbox.holder.kill('SIGKILL');
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

/** 造五类目录：2 天前无占用 / 2 天前有占用（子进程持有 cwd）/ 刚建 / 名字不匹配 / npm cache。 */
async function buildSandbox(): Promise<Sandbox> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-gc-test-'));
  const sandbox: Sandbox = {
    root,
    staleFree: path.join(root, 'vitest-stale-free'),
    held: path.join(root, 'code-agent-held'),
    fresh: path.join(root, 'gates-fast-fresh'),
    unrelated: path.join(root, 'unrelated-name'),
    npmCache: path.join(root, 'code-agent-npm-cache'),
    holder: null as unknown as ChildProcess,
  };
  for (const dir of [sandbox.staleFree, sandbox.held, sandbox.fresh, sandbox.unrelated, sandbox.npmCache]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'f'), 'x');
  }
  const stale = new Date(Date.now() - TWO_DAYS_MS);
  // 先写内容再改 mtime——建文件会把目录 mtime 刷成现在。
  for (const dir of [sandbox.staleFree, sandbox.held, sandbox.unrelated, sandbox.npmCache]) {
    fs.utimesSync(dir, stale, stale);
  }
  sandbox.holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    cwd: sandbox.held,
    stdio: 'ignore',
  });
  sandboxes.push(sandbox);
  await new Promise((resolve) => sandbox.holder.once('spawn', resolve));
  return sandbox;
}

function runGc(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  // gc 对每个超龄候选起 lsof 子进程，同步等待给足余量。
  const result = spawnSync(process.execPath, [gcScript, '--root', root, ...args], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('gc-stale-tmp 回收脚本（N-GATES-TMP-SELFCLEAN）', () => {
  it('默认 dry-run：只报告不删，超龄无占用的列出「将删除」', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, []);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[dry-run] 将删除 ${sandbox.staleFree}`);
    // 占用的在 dry-run 也要被点名，不能装作没看见
    expect(result.stderr).toContain(sandbox.held);
    expect(result.stderr).toContain('占用');
    for (const dir of [sandbox.staleFree, sandbox.held, sandbox.fresh, sandbox.unrelated, sandbox.npmCache]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
  }, 30_000);

  it('--execute：只删「2 天前且无占用」一类；占用/刚建/不匹配/npm cache 全保留且占用者 fail-loud 列出', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, ['--execute']);

    expect(result.status).toBe(0);
    // 第一类：唯一该删的
    expect(fs.existsSync(sandbox.staleFree)).toBe(false);
    // 第二类：有进程占着（cwd），保留且逐条 fail-loud（路径+原因）
    expect(fs.existsSync(sandbox.held)).toBe(true);
    expect(result.stderr).toContain(sandbox.held);
    expect(result.stderr).toMatch(/仍被进程占用/);
    // 第三类：刚建
    expect(fs.existsSync(sandbox.fresh)).toBe(true);
    // 第四类：名字不匹配
    expect(fs.existsSync(sandbox.unrelated)).toBe(true);
    expect(result.stdout).not.toContain(sandbox.unrelated);
    // 排除名单：npm cache 按约定不清，但要留痕
    expect(fs.existsSync(sandbox.npmCache)).toBe(true);
    expect(result.stderr).toContain(sandbox.npmCache);
    expect(result.stderr).toContain('npm cache');
  }, 30_000);
});
