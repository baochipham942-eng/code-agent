import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCasebankFixture } from '../utils/casebankFixture';

// N-GATES-TMP-SELFCLEAN 验收②：eval-ci（事件桥/真跑桥）的 caseDataDir 家族走 tmp-sandbox，
// 进程被 SIGTERM 时自清；--keep-tmp 时保留并打印路径。走真实 CLI 入口（tsx + eval-ci.ts），
// 不是模块级替身——wiring 断言贴在 tests/unit/testing/evalCiReport.test.ts。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const evalScript = path.join(repoRoot, 'packages', 'internal', 'evaluation-center', 'scripts', 'eval-ci.ts');
const DATA_DIR_PREFIX = 'code-agent-eval-data-';

let fixture: Awaited<ReturnType<typeof createCasebankFixture>>;
const keptDirs: string[] = [];

beforeAll(async () => {
  fixture = await createCasebankFixture();
});

afterAll(() => {
  fixture.cleanup();
  for (const dir of keptDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function existingEvalDataDirs(): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(DATA_DIR_PREFIX)));
}

async function waitFor(probe: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等不到 ${what}（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

interface EvalChild {
  child: ChildProcess;
  stderr: string;
  /** 等这轮 eval-ci 新建出来的数据根（os.tmpdir() 下 code-agent-eval-data-*）出现。 */
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
  // 事件桥只有在没有外部 CODE_AGENT_DATA_DIR 时才自建数据根——彻底删掉这个键。
  delete env.CODE_AGENT_DATA_DIR;
  const child = spawn(process.execPath, [tsxCli, evalScript, '--scope', 'smoke', '--max-cases', '1', '--json-events', ...extraArgs], {
    cwd: fixture.repoRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return {
    child,
    get stderr() { return stderr; },
    async waitForDataDir(timeoutMs = 60_000) {
      await waitFor(() => {
        for (const name of existingEvalDataDirs()) if (!before.has(name)) return true;
        return false;
      }, timeoutMs, 'eval-ci 新建的 code-agent-eval-data-* 目录');
      for (const name of existingEvalDataDirs()) {
        if (!before.has(name)) return path.join(os.tmpdir(), name);
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
  it('SIGTERM：这轮建的 code-agent-eval-data-* 数据根被清掉', async () => {
    const started = spawnEvalCi([]);
    const dataDir = await started.waitForDataDir();
    expect(fs.existsSync(dataDir)).toBe(true);

    started.child.kill('SIGTERM');
    await started.waitClosed();
    await waitFor(() => !fs.existsSync(dataDir), 10_000, '数据根被清掉');
    expect(fs.existsSync(dataDir)).toBe(false);
  }, 120_000);

  it('--keep-tmp：SIGTERM 后数据根保留，且 stderr 打印了路径', async () => {
    const started = spawnEvalCi(['--keep-tmp']);
    const dataDir = await started.waitForDataDir();
    keptDirs.push(dataDir); // 无论断言红绿，测试收尾都要自己收走

    started.child.kill('SIGTERM');
    await started.waitClosed();
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(started.stderr).toContain(dataDir);
    expect(started.stderr).toContain('keep-tmp');
  }, 120_000);
});
