import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCasebankFixture } from '../utils/casebankFixture';

// N-GATES-TMP-SELFCLEAN 验收②：eval-ci（事件桥/真跑桥）的 caseDataDir 家族走 tmp-sandbox，
// 进程被 SIGTERM 时自清；--keep-tmp 时保留并打印路径。走真实 CLI 入口（tsx loader + eval-ci.ts），
// 不是模块级替身——wiring 断言贴在 tests/unit/testing/evalCiReport.test.ts。
//
// 触发时机用**文件系统**信号（tmp 目录里出现新数据根）而不是 stdout 事件：满载时管道里的
// run_start 可能拖到子进程整跑完、数据根已 release 之后才送达（配对跑实测竞态）。
// --repeat 3 把数据根的存活窗口拉宽到秒级，50ms 轮询稳稳落在窗口内。
//
// N-EVALTMP-TSX-SOCKPATH：子进程用 `node --import <tsx loader>` 起，不用 tsx CLI。
// CLI 会 `listen $TMPDIR/tsx-<uid>/<pid>.pipe`；本测试把 TMPDIR 嵌在 vitest run 根下，
// 套接字路径在 CI macOS 上超过 sun_path=104，listen EINVAL，eval-ci 还没建数据根就退了。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxLoader = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-ci.ts');
const DATA_DIR_PREFIX = 'code-agent-eval-data-';
/** Darwin `sockaddr_un.sun_path`；tsx CLI 的 IPC 套接字必须短于这个值。 */
const MACOS_UNIX_SOCKET_MAX = 104;

let fixture: Awaited<ReturnType<typeof createCasebankFixture>>;
const keptDirs: string[] = [];
// 私有 TMPDIR：这轮 eval-ci 的 code-agent-eval-data-* 数据根只落在这里。整目录满载跑时，
// 其它 eval 测试（如 evalConfigIsolation 把 CODE_AGENT_DATA_DIR 置空串）的 eval-ci 子进程
// 也会在共享 tmpdir 自建同名根——不隔离的话「新出现的目录」可能抓成别人的，然后永远等不到
// 它被清掉（实测满载 flake，见 ~/work/out/N-GATES-TMP-SELFCLEAN/）。
const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-eval-tmp-sandbox-test-'));

beforeAll(async () => {
  fixture = await createCasebankFixture();
});

afterAll(() => {
  fixture.cleanup();
  for (const dir of keptDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(privateTmp, { recursive: true, force: true });
});

function existingEvalDataDirs(): Set<string> {
  return new Set(fs.readdirSync(privateTmp).filter((name) => name.startsWith(DATA_DIR_PREFIX)));
}

async function waitFor(probe: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等不到 ${what}（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function evalCiChildArgs(extraArgs: string[]): string[] {
  return ['--import', tsxLoader, evalScript, '--scope', 'smoke', '--max-cases', '3', '--repeat', '3', '--json-events', ...extraArgs];
}

function assertTsxLoaderSpawn(args: readonly string[]): void {
  const usingLoader = args[0] === '--import' && args[1] === tsxLoader;
  const usingCli = args.includes(tsxCli);
  if (!usingLoader || usingCli) {
    throw new Error(
      'eval-ci child must start as `node --import <tsx loader> <eval-ci.ts>` (no IPC server). '
      + 'The tsx CLI listens on `$TMPDIR/tsx-<uid>/<pid>.pipe`; a nested vitest TMPDIR makes that path '
      + `exceed macOS sun_path=${MACOS_UNIX_SOCKET_MAX} and listen() fails with EINVAL before eval-ci creates its data root.`,
    );
  }
}

function tsxIpcPipePaths(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('tsx-')) continue;
    const dir = path.join(root, name);
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const ent of fs.readdirSync(dir)) {
      if (ent.endsWith('.pipe')) found.push(path.join(dir, ent));
    }
  }
  return found;
}

function assertNoTsxIpcSocket(root: string): void {
  const pipes = tsxIpcPipePaths(root);
  if (pipes.length > 0) {
    throw new Error(
      `eval-ci child created tsx CLI IPC socket(s) under TMPDIR: ${pipes.join(', ')}. `
      + 'Start via `node --import <tsx loader>`, which creates no IPC server.',
    );
  }
}

interface EvalChild {
  child: ChildProcess;
  stderr: string;
  /** 等 stdout 出现 run_start 事件（数据根此刻必然已建），返回数据根路径。 */
  waitForDataDir(timeoutMs?: number): Promise<string>;
  waitClosed(timeoutMs?: number): Promise<number | null>;
}

function spawnEvalCi(extraArgs: string[]): EvalChild {
  const before = existingEvalDataDirs();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...fixture.env,
    TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.json'),
  };
  // 事件桥只有在没有外部 CODE_AGENT_DATA_DIR 时才自建数据根——彻底删掉这个键
  // （vitest 的 globalSetup 会给 worker 塞一个 run 级数据目录，不删的话 eval-ci 永远不自建）。
  delete env.CODE_AGENT_DATA_DIR;
  env.TMPDIR = privateTmp;
  const childArgs = evalCiChildArgs(extraArgs);
  assertTsxLoaderSpawn(childArgs);
  const child = spawn(process.execPath, childArgs, {
    cwd: fixture.repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return {
    child,
    get stderr() { return stderr; },
    async waitForDataDir(timeoutMs = 90_000) {
      await waitFor(() => {
        for (const name of existingEvalDataDirs()) if (!before.has(name)) return true;
        if (child.exitCode !== null || child.signalCode !== null) {
          // 子进程先退了：把 stderr 尾部带出来，否则只能对着超时猜。
          throw new Error(`eval-ci 未建数据根就退出了（exit=${child.exitCode} signal=${child.signalCode}）：\n${stderr.slice(-2_000)}`);
        }
        return false;
      }, timeoutMs, 'eval-ci 新建的 code-agent-eval-data-* 目录');
      assertNoTsxIpcSocket(privateTmp);
      for (const name of existingEvalDataDirs()) {
        if (!before.has(name)) return path.join(privateTmp, name);
      }
      throw new Error('unreachable');
    },
    async waitClosed(timeoutMs = 30_000) {
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs, 'eval-ci 退出');
      return child.exitCode;
    },
  };
}

describe('eval-ci 事件桥临时数据目录退出自清（N-GATES-TMP-SELFCLEAN）', () => {
  it('starts eval-ci through the tsx loader and creates no IPC socket under TMPDIR', () => {
    const args = evalCiChildArgs([]);
    assertTsxLoaderSpawn(args);
    expect(args[0]).toBe('--import');
    expect(args[1]).toBe(tsxLoader);
    expect(args).not.toContain(tsxCli);
    expect(tsxIpcPipePaths(privateTmp)).toEqual([]);
  });

  it('SIGTERM：这轮建的 code-agent-eval-data-* 数据根被清掉', async () => {
    const started = spawnEvalCi([]);
    const dataDir = await started.waitForDataDir();
    expect(fs.existsSync(dataDir)).toBe(true);

    started.child.kill('SIGTERM');
    await started.waitClosed();
    await waitFor(() => !fs.existsSync(dataDir), 10_000, '数据根被清掉');
    expect(fs.existsSync(dataDir)).toBe(false);
  }, 180_000);

  it('--keep-tmp：SIGTERM 后数据根保留，且 stderr 打印了路径', async () => {
    const started = spawnEvalCi(['--keep-tmp']);
    const dataDir = await started.waitForDataDir();
    keptDirs.push(dataDir); // 无论断言红绿，测试收尾都要自己收走

    started.child.kill('SIGTERM');
    await started.waitClosed();
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(started.stderr).toContain(dataDir);
    expect(started.stderr).toContain('keep-tmp');
  }, 180_000);
});
