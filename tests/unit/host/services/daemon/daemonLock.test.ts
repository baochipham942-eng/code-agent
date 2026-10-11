// ============================================================================
// daemonLock 单测（ADR-083 ①）：pid 文件 + 单实例锁 + pid 复用防线
//   - 两个实例并发抢锁：'wx' 原子创建保证只有一个赢；输家拿到赢家的 pid 让位。
//   - 活 pid 持锁（标记吻合 = owned / 无标记 = unknown）：第二个实例让位，不抢。
//   - 死 pid（陈旧锁）与标记不符的活 pid（pid 已被复用 = foreign）：接管成功。
//   - 读不出 pid 的锁文件（赢家刚建文件还没写完）：按「有实例正在启动」让位。
//   - release：本进程写的锁才删；文件指着别人（含接任者）时不删。
// 夹具用真实子进程取「活 pid / 死 pid」、真实 `ps lstart` 取启动标记，不 mock
// 进程语义——被测对象就是「读文件 / 比身份 / 删文件」。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  acquireDaemonLock,
  inspectDaemonPid,
  readDaemonPidRecord,
  releaseDaemonLock,
} from '../../../../../src/host/services/daemon/daemonLock';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-lock-'));
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

/** 真实读取进程启动标记（与实现同源口径：`ps lstart`）。 */
function psLstart(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
}

/** 把 pid 记录写进 dataDir（等价于某次持锁写下的文件内容）。 */
function writePidRecord(dataDir: string, pid: number, startTime: string | null): void {
  fs.writeFileSync(path.join(dataDir, 'daemon.pid'), JSON.stringify({ pid, startTime }));
}

/** 起一个立即退出的子进程，拿一个保证已死的 pid。 */
function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid!));
  });
}

/** 起一个常驻子进程，拿一个保证活着的 pid；返回停止函数。 */
function spawnLivePid(): Promise<{ pid: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    child.on('error', reject);
    const ready = setInterval(() => {
      if (child.pid && isAlive(child.pid)) {
        clearInterval(ready);
        resolve({
          pid: child.pid,
          stop: () => new Promise((done) => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
          }),
        });
      }
    }, 20);
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('inspectDaemonPid', () => {
  it('四态判别：dead / owned / foreign / unknown（pid 复用防线）', async () => {
    const deadPid = await spawnDeadPid();
    expect(isAlive(deadPid)).toBe(false);
    // dead 分支不看标记（进程不在就先返回），随便给个值即可。
    expect(inspectDaemonPid({ pid: deadPid, startTime: 'Fri Jan  1 00:00:00 1970' })).toBe('dead');

    const live = await spawnLivePid();
    try {
      // 标记吻合 = owned（就是写文件的守护）
      expect(inspectDaemonPid({ pid: live.pid, startTime: psLstart(live.pid) })).toBe('owned');
      // 标记不符 = foreign（pid 已被复用，不是写文件的那个进程）
      expect(inspectDaemonPid({ pid: live.pid, startTime: 'Fri Jan  1 00:00:00 1970' })).toBe('foreign');
      // 无标记（旧版纯 pid 文件）= unknown（活着但证明不了身份）
      expect(inspectDaemonPid({ pid: live.pid, startTime: null })).toBe('unknown');
    } finally {
      await live.stop();
    }
  });
});

describe('acquireDaemonLock', () => {
  it('并发抢锁只有一个赢家，输家让位并拿到赢家的 pid（ADR-083 ①）', async () => {
    const dataDir = makeTempDir();
    // 赢家必须用真实活 pid：pid 文件里是死 pid 时第二个 acquire 按陈旧锁接管
    // （那是下面那条用例的行为），这里测的是「活持有者在场时输家让位」。
    // 'wx' 是原子操作：两个 acquire 与两个进程抢同一个 open(path, 'wx') 等价。
    const winner = await spawnLivePid();
    try {
      const first = acquireDaemonLock(dataDir, winner.pid);
      const second = acquireDaemonLock(dataDir, 222_222);
      const winners = [first, second].filter((r) => r.acquired);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual({ acquired: true, pid: winner.pid });
      expect(second).toEqual({ acquired: false, existingPid: winner.pid });
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(winner.pid);
    } finally {
      await winner.stop();
    }
  });

  it('持锁文件是含启动标记的 JSON 记录（pid 复用判别的数据面）', async () => {
    const dataDir = makeTempDir();
    const winner = await spawnLivePid();
    try {
      expect(acquireDaemonLock(dataDir, winner.pid)).toEqual({ acquired: true, pid: winner.pid });
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.pid'), 'utf8'));
      expect(raw).toEqual({ pid: winner.pid, startTime: psLstart(winner.pid) });
    } finally {
      await winner.stop();
    }
  });

  it('旧版纯 pid 文件指着活进程：按身份未知让位，不抢也不删', async () => {
    const dataDir = makeTempDir();
    const live = await spawnLivePid();
    try {
      fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(live.pid));
      const result = acquireDaemonLock(dataDir, 222);
      expect(result).toEqual({ acquired: false, existingPid: live.pid });
      // 锁文件原样保留，归属仍是活着的持有者。
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(live.pid);
    } finally {
      await live.stop();
    }
  });

  it('活 pid 但启动标记不符（pid 已被复用）：接管，不让位', async () => {
    const dataDir = makeTempDir();
    const live = await spawnLivePid();
    try {
      writePidRecord(dataDir, live.pid, 'Fri Jan  1 00:00:00 1970');
      const result = acquireDaemonLock(dataDir, 333);
      expect(result).toEqual({ acquired: true, pid: 333 });
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(333);
    } finally {
      await live.stop();
    }
  });

  it('死 pid（陈旧锁）被接管（ADR-083 ①）', async () => {
    const dataDir = makeTempDir();
    const deadPid = await spawnDeadPid();
    expect(isAlive(deadPid)).toBe(false);
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(deadPid));
    const result = acquireDaemonLock(dataDir, 333);
    expect(result).toEqual({ acquired: true, pid: 333 });
    expect(readDaemonPidRecord(dataDir)?.pid).toBe(333);
  });

  it('锁文件在但读不出 pid：按「有实例正在启动」让位，不删文件', () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), '');
    const result = acquireDaemonLock(dataDir, 444);
    expect(result).toEqual({ acquired: false, existingPid: null });
    expect(fs.existsSync(path.join(dataDir, 'daemon.pid'))).toBe(true);
  });
});

describe('releaseDaemonLock', () => {
  it('本进程持有的锁释放后下一个实例可以获取；无文件时 no-op 不抛', () => {
    const dataDir = makeTempDir();
    expect(acquireDaemonLock(dataDir)).toEqual({ acquired: true, pid: process.pid });
    releaseDaemonLock(dataDir);
    expect(readDaemonPidRecord(dataDir)).toBeNull();
    expect(acquireDaemonLock(dataDir)).toEqual({ acquired: true, pid: process.pid });
    expect(() => releaseDaemonLock(dataDir)).not.toThrow();
  });

  it('本进程写的无标记记录（取不到 lstart 的平台）也能释放：pid 相等即归属', () => {
    const dataDir = makeTempDir();
    writePidRecord(dataDir, process.pid, null);
    releaseDaemonLock(dataDir);
    expect(readDaemonPidRecord(dataDir)).toBeNull();
  });

  it('文件指着别的活进程时不删：迟到的 shutdown 回调删不掉接任者的锁', async () => {
    const dataDir = makeTempDir();
    const live = await spawnLivePid();
    try {
      writePidRecord(dataDir, live.pid, psLstart(live.pid));
      releaseDaemonLock(dataDir);
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(live.pid);
    } finally {
      await live.stop();
    }
  });
});
