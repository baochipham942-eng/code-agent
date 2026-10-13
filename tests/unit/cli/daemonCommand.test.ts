// ============================================================================
// `neo daemon status` / `neo daemon stop` 单测（ADR-083 ②/③ 的客户端面）：
//   - status：pid 记录四态（无 / owned 活 / 陈旧死 pid / pid 被复用）+ durable_runs
//     名册（有 run 逐行列 id/status/session/owner；空名册明确打「No runs in
//     progress.」）。
//   - stop：对「身份吻合（owned）」的 pid 文件进程发 SIGTERM 并等到它退出；
//     陈旧 pid / 无 pid 文件 / pid 被复用时明确说没事可停；身份未知（旧版纯
//     pid 文件指着活进程）时拒绝发信号——pid 复用会误杀无辜进程。
// 夹具：真实临时数据目录（CODE_AGENT_DATA_DIR）+ 真实 sqlite + 真实子进程 +
// 真实 `ps lstart` 启动标记，不 mock 进程语义——被测对象就是「读文件 / 比身份 /
// 发信号 / 等退出」。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { daemonCliCommand } from '../../../src/cli/commands/daemon';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const tempDirs: string[] = [];
let dataDir: string;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-cli-'));
  tempDirs.push(dir);
  return dir;
}

/** 与 daemonLock 同款活性判据（process.kill(pid, 0)，EPERM = 活）：测试自用，不引被测实现。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 等进程真正消失（僵尸要等父进程收尸后 kill(pid,0) 才开始失败；收尸时机不归
 * 被测的 CLI 管，断言侧有界等待）。 */
async function waitUntilReaped(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return !isAlive(pid);
}

/** 真实读取进程启动标记（与实现同源口径：`ps lstart`）。 */
function psLstart(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
}

/** 把 pid 记录写进 dataDir：marker 为真值 = 一份「身份可证明」的 pid 文件。 */
function writePidRecord(dataDir: string, pid: number, startTime: string | null): void {
  fs.writeFileSync(path.join(dataDir, 'daemon.pid'), JSON.stringify({ pid, startTime }));
}

interface IO {
  stdout: () => string;
  stderr: () => string;
}

function mockProcessIO(): IO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  return { stdout: () => stdout.join(''), stderr: () => stderr.join('') };
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.addCommand(daemonCliCommand);
  return program;
}

async function runDaemon(args: string[]): Promise<IO> {
  const io = mockProcessIO();
  await makeProgram().parseAsync(['node', 'neo', 'daemon', ...args]);
  return io;
}

/** 起一个模拟 daemon 的子进程：活得住、收到 SIGTERM 干净退出。 */
function spawnFakeDaemon(): Promise<{ pid: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1 << 30);
    `], { stdio: 'ignore' });
    child.on('error', reject);
    const ready = setInterval(() => {
      if (child.pid) {
        clearInterval(ready);
        resolve({
          pid: child.pid,
          stop: () => new Promise((done) => {
            // stop 可能在 daemon stop 命令已经把它杀掉之后才调用：先看是否已退，
            // 已退就不能再等 'exit'（早已发过，再挂监听永远不触发）。
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once('exit', () => done());
            child.kill('SIGKILL');
          }),
        });
      }
    }, 20);
  });
}

/** 起一个常驻但**不是 node** 的子进程（/bin/sleep）：命令行不含 node，用来造
 * 「启动标记吻合、但 pid 已归非 node 进程」的身份不符现场（返修 Important 2）。 */
function spawnNonNodePid(): Promise<{ pid: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    child.on('error', reject);
    const ready = setInterval(() => {
      if (child.pid) {
        clearInterval(ready);
        resolve({
          pid: child.pid,
          stop: () => new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once('exit', () => done());
            child.kill('SIGKILL');
          }),
        });
      }
    }, 20);
  });
}

/** 在 dataDir 里建库（迁移到 durable_runs 表），可选再种一条活跃 run（kernel 真写，非 mock）。 */
async function seedRosterDb(withRun: boolean): Promise<void> {
  const db = new Database(path.join(dataDir, 'code-agent.db'));
  try {
    const repo = new DurableRunRepository(db);
    repo.migrate();
    if (!withRun) return;
    const kernel = new DurableRunKernel({
      stores: repo,
      ownerId: 'owner-alpha',
      processInstanceId: 'pi-cli-1',
      leaseDurationMs: 60_000,
    });
    await kernel.createRun({ runId: 'run-alpha', sessionId: 'sess-1', engine: { kind: 'native' }, now: 1_000 });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dataDir = makeTempDir();
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('neo daemon status', () => {
  it('无 pid 文件 + 空名册：明确说 daemon 不在跑、没有在跑的 run（ADR-083 ②）', async () => {
    await seedRosterDb(false);
    const io = await runDaemon(['status']);
    expect(io.stdout()).toContain('Daemon: not running');
    expect(io.stdout()).toContain('No runs in progress.');
  });

  it('身份吻合的活 pid + 名册有 run：列 daemon pid 与 run 的 id/status/session/owner（ADR-083 ②）', async () => {
    await seedRosterDb(true);
    const fake = await spawnFakeDaemon();
    try {
      writePidRecord(dataDir, fake.pid, psLstart(fake.pid));
      const io = await runDaemon(['status']);
      expect(io.stdout()).toContain(`Daemon: running (pid ${fake.pid})`);
      expect(io.stdout()).toContain('Runs in progress (1):');
      expect(io.stdout()).toContain('run-alpha');
      expect(io.stdout()).toContain('status=running');
      expect(io.stdout()).toContain('session=sess-1');
      expect(io.stdout()).toContain('owner=owner-alpha');
    } finally {
      await fake.stop();
    }
  });

  it('陈旧 pid：明说是陈旧 pid 文件；库不存在时名册按不可用报告', async () => {
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), '999999999');
    const io = await runDaemon(['status']);
    expect(io.stdout()).toContain('stale pid file');
    expect(io.stdout()).toContain('Run roster: unavailable');
  });

  it('pid 被复用（标记不符的活 pid）：明说是陈旧 pid 文件、pid 已归别的进程', async () => {
    const reused = await spawnFakeDaemon();
    try {
      writePidRecord(dataDir, reused.pid, 'Fri Jan  1 00:00:00 1970');
      const io = await runDaemon(['status']);
      expect(io.stdout()).toContain('Daemon: not running');
      expect(io.stdout()).toContain(`pid ${reused.pid} was reused by another process`);
    } finally {
      await reused.stop();
    }
  });
});

describe('neo daemon stop', () => {
  it('对身份吻合的 pid 发 SIGTERM 并等到退出（ADR-083 ③ 客户端面）', async () => {
    const fake = await spawnFakeDaemon();
    try {
      writePidRecord(dataDir, fake.pid, psLstart(fake.pid));
      const io = await runDaemon(['stop']);
      expect(io.stdout()).toContain(`SIGTERM sent to daemon (pid ${fake.pid})`);
      expect(io.stdout()).toContain('Daemon stopped.');
      expect(await waitUntilReaped(fake.pid)).toBe(true);
    } finally {
      await fake.stop();
    }
  }, 15_000);

  it('无 pid 文件 / 陈旧 pid / pid 被复用：明确说没事可停，不发信号', async () => {
    const noFile = await runDaemon(['stop']);
    expect(noFile.stdout()).toContain('nothing to stop');
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), '999999999');
    const stale = await runDaemon(['stop']);
    expect(stale.stdout()).toContain('stale pid file');
    expect(stale.stdout()).toContain('nothing to stop');
    const reused = await spawnFakeDaemon();
    try {
      writePidRecord(dataDir, reused.pid, 'Fri Jan  1 00:00:00 1970');
      const foreign = await runDaemon(['stop']);
      expect(foreign.stdout()).toContain('reused by another process');
      expect(foreign.stdout()).toContain('nothing to stop');
      expect(isAlive(reused.pid)).toBe(true); // 没被误杀
    } finally {
      await reused.stop();
    }
  });

  it('活 pid、启动标记吻合但命令行不含 node（pid 已归非 node 进程）：按复用处理，不发信号（返修 Important 2）', async () => {
    const nonNode = await spawnNonNodePid();
    try {
      writePidRecord(dataDir, nonNode.pid, psLstart(nonNode.pid));
      const stop = await runDaemon(['stop']);
      expect(stop.stdout()).toContain('reused by another process');
      expect(stop.stdout()).toContain('nothing to stop');
      expect(isAlive(nonNode.pid)).toBe(true); // 没被误杀
      const status = await runDaemon(['status']);
      expect(status.stdout()).toContain('Daemon: not running');
      expect(status.stdout()).toContain(`pid ${nonNode.pid} was reused by another process`);
    } finally {
      await nonNode.stop();
    }
  });

  it('旧版纯 pid 文件指着活进程：身份无法证明，拒绝发信号（fail-closed）', async () => {
    const live = await spawnFakeDaemon();
    try {
      fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(live.pid));
      const io = await runDaemon(['stop']);
      expect(io.stderr()).toContain('refusing to signal it');
      expect(process.exitCode).toBe(1);
      expect(isAlive(live.pid)).toBe(true); // 没被误杀
    } finally {
      await live.stop();
    }
  });
});

// ── win32 平台裁剪（返修 2026-10-13 Important 2）────────────────────────────
// win32 无进程身份源，锁整个不生效；status/stop 得明说「本平台不支持」，而不是
// 对着身份永远 unknown 的 pid 文件谎称 not running / 拒绝发信号。
describe('win32：daemon lock 不支持时的客户端口径', () => {
  it('status：说不支持，不谎称 not running；run 名册照常读（名册与锁无关）', async () => {
    await seedRosterDb(false);
    const live = await spawnFakeDaemon();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      writePidRecord(dataDir, live.pid, psLstart(live.pid));
      const io = await runDaemon(['status']);
      expect(io.stdout()).toContain('not supported on this platform');
      expect(io.stdout()).not.toContain('not running');
      expect(io.stdout()).not.toContain('cannot prove');
      expect(io.stdout()).toContain('No runs in progress.');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      await live.stop();
    }
  });

  it('stop：说不支持、没事可停，不发信号也不置错误码', async () => {
    const live = await spawnFakeDaemon();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      writePidRecord(dataDir, live.pid, psLstart(live.pid));
      const io = await runDaemon(['stop']);
      expect(io.stdout()).toContain('not supported on this platform');
      expect(io.stderr()).toBe('');
      expect(process.exitCode).toBeUndefined();
      expect(isAlive(live.pid)).toBe(true); // 没被误杀
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      await live.stop();
    }
  });
});
