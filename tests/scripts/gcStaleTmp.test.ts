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
  staleVitestRun: string;
  held: string;
  fresh: string;
  unrelated: string;
  npmCache: string;
  worktrees: string;
  uploads: string;
  staleFile: string;
  holder: ChildProcess;
}

const sandboxes: Sandbox[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    if (sandbox.holder.exitCode === null && !sandbox.holder.killed) sandbox.holder.kill('SIGKILL');
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

/**
 * 造十类条目（返修 r2 后的删除范围形状）：
 *   ① 2 天前无占用（该删）② 本仓 vitest run 根超龄无占用（该删，globalSetup.ts 的前缀）
 *   ③ 2 天前有占用（子进程持有 cwd）④ 刚建 ⑤ 名字不匹配 ⑥ npm cache（白名单外，天然不匹配）
 *   ⑦⑧ 产品长期目录 code-agent-worktrees / code-agent-uploads（>24h 也绝不进候选）
 *   ⑨ 名字撞白名单的非目录文件 ⑩ 无关名字的目录同⑤。
 */
async function buildSandbox(): Promise<Sandbox> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-gc-test-'));
  const sandbox: Sandbox = {
    root,
    staleFree: path.join(root, 'vitest-stale-free'),
    staleVitestRun: path.join(root, 'code-agent-vitest-run-abc123'),
    held: path.join(root, 'code-agent-eval-data-held'),
    fresh: path.join(root, 'gates-fast-fresh'),
    unrelated: path.join(root, 'unrelated-name'),
    npmCache: path.join(root, 'code-agent-npm-cache'),
    worktrees: path.join(root, 'code-agent-worktrees'),
    uploads: path.join(root, 'code-agent-uploads'),
    staleFile: path.join(root, 'vitest-flake-diagnostics-123456.json'),
    holder: null as unknown as ChildProcess,
  };
  for (const dir of [sandbox.staleFree, sandbox.staleVitestRun, sandbox.held, sandbox.fresh, sandbox.unrelated, sandbox.npmCache, sandbox.worktrees, sandbox.uploads]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'f'), 'x');
  }
  fs.writeFileSync(sandbox.staleFile, '{"flake":true}');
  const stale = new Date(Date.now() - TWO_DAYS_MS);
  // 先写内容再改 mtime——建文件会把目录 mtime 刷成现在。
  for (const p of [sandbox.staleFree, sandbox.staleVitestRun, sandbox.held, sandbox.unrelated, sandbox.npmCache, sandbox.worktrees, sandbox.uploads, sandbox.staleFile]) {
    fs.utimesSync(p, stale, stale);
  }
  sandbox.holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    cwd: sandbox.held,
    stdio: 'ignore',
  });
  sandboxes.push(sandbox);
  await new Promise((resolve) => sandbox.holder.once('spawn', resolve));
  return sandbox;
}

function runGc(root: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  // gc 对每个超龄候选起 lsof 子进程，同步等待给足余量。
  const result = spawnSync(process.execPath, [gcScript, '--root', root, ...args], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('gc-stale-tmp 回收脚本（N-GATES-TMP-SELFCLEAN）', () => {
  it('默认 dry-run：只报告不删，超龄无占用的列出「将删除」', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, []);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[dry-run] 将删除 ${sandbox.staleFree}`);
    expect(result.stdout).toContain(`[dry-run] 将删除 ${sandbox.staleVitestRun}`);
    // 占用的在 dry-run 也要被点名，不能装作没看见
    expect(result.stderr).toContain(sandbox.held);
    expect(result.stderr).toContain('占用');
    // 白名单外（产品长期目录、npm cache）不出现在删除清单里
    for (const dir of [sandbox.worktrees, sandbox.uploads, sandbox.npmCache]) {
      expect(result.stdout).not.toContain(dir);
    }
    for (const p of [sandbox.staleFree, sandbox.staleVitestRun, sandbox.held, sandbox.fresh, sandbox.unrelated, sandbox.npmCache, sandbox.worktrees, sandbox.uploads, sandbox.staleFile]) {
      expect(fs.existsSync(p)).toBe(true);
    }
  }, 30_000);

  it('--execute：只删「2 天前且无占用」一类；占用/刚建/不匹配/npm cache 全保留且占用者 fail-loud 列出', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, ['--execute']);

    expect(result.status).toBe(0);
    // 第一类：超龄无占用的白名单目录（vitest 库目录 + 本仓 vitest run 根）
    expect(fs.existsSync(sandbox.staleFree)).toBe(false);
    expect(fs.existsSync(sandbox.staleVitestRun)).toBe(false);
    // 第二类：有进程占着（cwd），保留且逐条 fail-loud（路径+原因）
    expect(fs.existsSync(sandbox.held)).toBe(true);
    expect(result.stderr).toContain(sandbox.held);
    expect(result.stderr).toMatch(/仍被进程占用/);
    // 第三类：刚建
    expect(fs.existsSync(sandbox.fresh)).toBe(true);
    // 第四类：名字不匹配
    expect(fs.existsSync(sandbox.unrelated)).toBe(true);
    expect(result.stdout).not.toContain(sandbox.unrelated);
    // npm cache：白名单外不进候选，按约定不清
    expect(fs.existsSync(sandbox.npmCache)).toBe(true);
    expect(result.stdout).not.toContain(sandbox.npmCache);
  }, 30_000);

  it('白名单（返修 r2）：产品长期目录 code-agent-worktrees / code-agent-uploads 超龄+无占用也不删', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, ['--execute']);

    // 这两个目录是产品按设计长期保留的（agentWorktreePath.ts / web/helpers/upload.ts），
    // 顶层 mtime 超 24h 且无 lsof 占用是常态——白名单外的名字根本进不了候选。
    expect(fs.existsSync(sandbox.worktrees)).toBe(true);
    expect(fs.existsSync(sandbox.uploads)).toBe(true);
    expect(result.stdout).not.toContain(sandbox.worktrees);
    expect(result.stdout).not.toContain(sandbox.uploads);
    expect(result.stderr).not.toContain(sandbox.worktrees);
    // 同一轮里白名单内的超龄无占用目录照删，证明「不删」是名单挡的、不是这轮没删东西
    expect(fs.existsSync(sandbox.staleFree)).toBe(false);
    expect(fs.existsSync(sandbox.staleVitestRun)).toBe(false);
  }, 30_000);

  it('名字撞白名单的非目录条目（vitest-flake-diagnostics-*.json）计为 skipped：不删、不 failed、退出码 0', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, ['--execute']);

    expect(result.status).toBe(0);
    expect(fs.existsSync(sandbox.staleFile)).toBe(true);
    expect(result.stdout).toContain('1 个非目录跳过');
    // skipped 不是失败：没有 ✗ 失败行，汇总里失败数为 0
    expect(result.stderr).not.toContain(sandbox.staleFile);
    expect(result.stdout).toContain('0 个失败');
  }, 30_000);

  it('lsof 判占用超时：按「占用中」跳过不删（GC_STALE_TMP_LSOF_TIMEOUT_MS=1ms 必超时），退出码 0', async () => {
    const sandbox = await buildSandbox();
    const result = runGc(sandbox.root, ['--execute'], { GC_STALE_TMP_LSOF_TIMEOUT_MS: '1' });

    // 超时=判不了占用：宁可误判占用跳过，也不能跳过检查去删。
    expect(result.status).toBe(0);
    expect(fs.existsSync(sandbox.staleFree)).toBe(true);
    expect(result.stderr).toContain(sandbox.staleFree);
    expect(result.stderr).toMatch(/lsof 判占用超时/);
  }, 30_000);
});
