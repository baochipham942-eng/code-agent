// ============================================================================
// `neo daemon status` / `neo daemon stop` 单测（ADR-083 ②/③ 的客户端面）：
//   - status：pid 文件三态（无 / 活 pid / 陈旧 pid）+ durable_runs 名册
//     （有 run 逐行列 id/status/session/owner；空名册明确打「No runs in progress.」）。
//   - stop：对 pid 文件里的真子进程发 SIGTERM 并等到它退出；陈旧 pid / 无 pid
//     文件时明确说没事可停。
// 夹具：真实临时数据目录（CODE_AGENT_DATA_DIR）+ 真实 sqlite + 真实子进程，
// 不 mock 进程语义——被测对象就是「读文件 / 发信号 / 等退出」。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { daemonCliCommand } from '../../../src/cli/commands/daemon';
import { isDaemonPidAlive } from '../../../src/host/daemon/daemonLock';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

const tempDirs: string[] = [];
let dataDir: string;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-cli-'));
  tempDirs.push(dir);
  return dir;
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

  it('活 pid + 名册有 run：列 daemon pid 与 run 的 id/status/session/owner（ADR-083 ②）', async () => {
    await seedRosterDb(true);
    const fake = await spawnFakeDaemon();
    try {
      fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(fake.pid));
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
});

describe('neo daemon stop', () => {
  it('对 pid 文件里的进程发 SIGTERM 并等到退出（ADR-083 ③ 客户端面）', async () => {
    const fake = await spawnFakeDaemon();
    try {
      fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(fake.pid));
      const io = await runDaemon(['stop']);
      expect(io.stdout()).toContain(`SIGTERM sent to daemon (pid ${fake.pid})`);
      expect(io.stdout()).toContain('Daemon stopped.');
      expect(isDaemonPidAlive(fake.pid)).toBe(false);
    } finally {
      await fake.stop();
    }
  }, 15_000);

  it('无 pid 文件 / 陈旧 pid：明确说没事可停，不发信号', async () => {
    const noFile = await runDaemon(['stop']);
    expect(noFile.stdout()).toContain('nothing to stop');
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), '999999999');
    const stale = await runDaemon(['stop']);
    expect(stale.stdout()).toContain('stale pid file');
    expect(stale.stdout()).toContain('nothing to stop');
  });
});
