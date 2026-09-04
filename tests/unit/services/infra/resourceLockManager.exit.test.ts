import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// N-EVAL-CI-NOEXIT：ResourceLockManager 构造时起的 cleanup setInterval(10s) 必须 unref——
// 不 unref 的话，只要进程创建过 manager（ToolExecutor 每次构造都会碰单例），事件循环永远
// 排不空，eval 真跑/approval 探针跑完都退不掉（09-02 持有者点名 Timeout 1 = resourceLockManager.ts:103）。
// 本测试 spawn 一个子进程：创建 manager、不 dispose，断言进程在时限内自然退出。
// 反向变异 M1：去掉 unref ⇒ 本测试超时红。

const sourceRepoRoot = process.cwd();
const tsxCli = path.join(sourceRepoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CHILD_EXIT_BUDGET_MS = 30_000;
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ResourceLockManager 进程自然退出（N-EVAL-CI-NOEXIT）', () => {
  it('manager 实例存活（未 dispose）时进程也能在时限内自然退出', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rlm-exit-'));
    tempDirs.push(dir);
    const childScript = path.join(dir, 'child.mts');
    await writeFile(childScript, [
      `import { ResourceLockManager } from ${JSON.stringify(path.join(sourceRepoRoot, 'src/host/services/infra/resourceLockManager.ts'))};`,
      `const manager = new ResourceLockManager();`,
      `await manager.acquire('probe-holder', 'resource-a');`,
      `console.log('lock-acquired');`,
      `// 故意不 dispose：cleanup setInterval 必须 unref，进程才能自然退出`,
    ].join('\n'));

    const result = await new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => {
      const child = spawn(process.execPath, [tsxCli, childScript], {
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(sourceRepoRoot, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({ exitCode: -1, timedOut: true });
      }, CHILD_EXIT_BUDGET_MS);
      const settle = (exitCode: number, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, timedOut });
      };
      child.once('error', () => settle(-1, false));
      child.once('close', (code) => settle(code ?? -1, false));
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, CHILD_EXIT_BUDGET_MS + 30_000);
});
