import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// N-WF-STALL-RESTART 进程级回归：两个真实 OS 进程先后打开同一个 sqlite 文件，钉死
// workflow stall 的 (run_id, epoch) 去重跨进程存活——announce 进程被 SIGKILL 后，重启
// 进程不重播已送达的 epoch 1，下一条是 previous max + 1（epoch 2），库里恰为 {1,2}。
// 进程夹具在 tests/e2e/fixtures/workflowStallProcessHost.ts（照 backgroundSubagentProcessHost
// 的相位 + marker 形状），这里只负责拉起、杀进程组、断言 marker 与 notices 文件。
//
// 反向变异：WF_STALL_MUTATION=skip-journal-seed 让夹具在 restart 相位给检测器传
// journal: null（模拟「不读 journal」的回归）→ epoch 1 被重播 → 本文件第一条用例变红。

const root = process.cwd();
const childEntry = path.join(root, 'tests/e2e/fixtures/workflowStallProcessHost.ts');
const tsxCli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const mutation = process.env.WF_STALL_MUTATION ?? '';

interface Marker extends Record<string, unknown> {
  marker: string;
  pid: number;
}

interface StallNoticeLine {
  phase: string;
  pid: number;
  epoch: number;
}

type Child = ChildProcessByStdio<null, Readable, Readable>;

function startChild(phase: string, dataDir: string): Child {
  return spawn(process.execPath, [tsxCli, childEntry, phase, dataDir], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dataDir,
      USERPROFILE: dataDir,
      NODE_ENV: 'test',
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_CLI_MODE: 'true',
      ...(mutation ? { WF_STALL_MUTATION: mutation } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // tsx CLI 会再 spawn 一层真正跑夹具的孙进程：独立进程组 + 负 pid 杀整组，
    // 才能真的干掉持有检测器的那个进程（同 durableRunKernel.test.ts 的注释）。
    detached: true,
  });
}

function waitForMarker(child: Child, expected: string): Promise<Marker> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${expected}; stdout=${stdout}; stderr=${stderr}`));
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        const parsed = JSON.parse(line) as Marker;
        if (parsed.marker === expected) {
          clearTimeout(timeout);
          resolve(parsed);
        }
        if (parsed.marker === 'fixture-assertion-failed') {
          clearTimeout(timeout);
          reject(new Error(`fixture assertion failed: ${parsed.message}`));
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`child exited ${code} before ${expected}; stdout lines lost; stderr=${stderr}`));
    });
  });
}

function isChildGone(child: Child): boolean {
  // exitCode 单看是错的存活判定：被信号打死时 exitCode 保持 null、信号落在 signalCode。
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: Child): Promise<number | null> {
  if (isChildGone(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/** SIGKILL 整个进程组（tsx CLI + 孙进程），并确认真的死干净。 */
async function forceKill(child: Child, fixturePid?: number): Promise<void> {
  const pids = [child.pid, fixturePid].filter((pid, index, all): pid is number =>
    typeof pid === 'number' && all.indexOf(pid) === index);
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 整组已退出 */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  await Promise.race([
    waitForExit(child),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`forceKill: pid ${child.pid} 在 10s 内未退出`)), 10_000)),
  ]);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pids.some(isPidAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const alive = pids.filter(isPidAlive);
  if (alive.length > 0) throw new Error(`forceKill: still alive after SIGKILL: ${alive.join(',')}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readNotices(dataDir: string): Promise<StallNoticeLine[]> {
  const text = await readFile(path.join(dataDir, 'notices.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as StallNoticeLine);
}

describe('WorkflowStallDetector across processes', () => {
  it('a restarted process does not re-announce epoch 1 and continues at previous max + 1', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'wf-stall-restart-'));
    const children: Child[] = [];
    try {
      // 相位 1：首进程播报 epoch 1 并落库，然后被 SIGKILL（不是干净退出）。
      const first = startChild('announce', dataDir);
      children.push(first);
      const announce = await waitForMarker(first, 'announce-done');
      await forceKill(first, announce.pid);
      // 断言「持有 epoch 1 的那个进程真的死了」，而不是「我们调用过 kill」。
      expect(() => process.kill(announce.pid, 0)).toThrow(/ESRCH/);

      // 相位 2：新进程、同一 sqlite 文件、同一 runId。
      const second = startChild('restart', dataDir);
      children.push(second);
      const restart = await waitForMarker(second, 'restart-done');
      expect(await waitForExit(second)).toBe(0);

      expect(announce.announced).toEqual([1]);
      expect(announce.dbEpochs).toEqual([1]);
      expect(restart.announced).toEqual([2]);
      expect(restart.dbEpochs).toEqual([1, 2]);
      expect(restart.mutation).toBe(mutation || null);

      // 模型面副作用全量核对：epoch 1 恰好送达一次（首进程），epoch 2 由第二个 pid 送达。
      const notices = await readNotices(dataDir);
      expect(notices.map((notice) => notice.epoch)).toEqual([1, 2]);
      expect(notices[0]!.pid).not.toBe(notices[1]!.pid);
      expect(notices[0]!.pid).toBe(announce.pid);
      expect(notices[1]!.pid).toBe(restart.pid);
    } finally {
      for (const child of children) {
        if (!isChildGone(child)) await forceKill(child).catch(() => undefined);
      }
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }, 120_000);

  it('degrades with a warn when the journal is missing or the db is not ready', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'wf-stall-degraded-'));
    try {
      const child = startChild('degraded', dataDir);
      const degraded = await waitForMarker(child, 'degraded-done');
      expect(await waitForExit(child)).toBe(0);

      const missingTable = degraded.missingTable as {
        announced: number[];
        warnings: Array<{ message: string; details?: Record<string, unknown> }>;
        readError: string;
      };
      // 表缺失：journal 读抛 → 降级 warn（带读失败原因）；写同样抛 → 模型面静默。
      expect(missingTable.readError).toContain('no such table: workflow_stall_notices');
      expect(missingTable.announced).toEqual([]);
      expect(missingTable.warnings).toContainEqual({
        message: 'workflow stall detector downgraded to in-process epochs',
        details: {
          runId: 'wf-stall-restart-proc',
          reason: 'journal read failed: no such table: workflow_stall_notices',
        },
      });

      // DB 未就绪（journal 为 null 的生产降级形状）：in-process epoch 继续播报 + 降级 warn。
      const nullJournal = degraded.nullJournal as {
        announced: number[];
        warnings: Array<{ message: string; details?: Record<string, unknown> }>;
      };
      expect(nullJournal.announced).toEqual([1]);
      expect(nullJournal.warnings).toContainEqual({
        message: 'workflow stall detector downgraded to in-process epochs',
        details: { runId: 'wf-stall-restart-proc', reason: 'workflow journal repository is unavailable' },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }, 120_000);
});
