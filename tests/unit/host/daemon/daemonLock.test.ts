// ============================================================================
// daemonLock 单测（ADR-083 ①）：pid 文件 + 单实例锁
//   - 两个实例并发抢锁：'wx' 原子创建保证只有一个赢；输家拿到赢家的 pid 让位。
//   - 活 pid 持锁：第二个实例让位，不抢。
//   - 死 pid（陈旧锁）：接管成功。
//   - 读不出 pid 的锁文件（赢家刚建文件还没写完）：按「有实例正在启动」让位。
//   - release 删文件；无文件时 no-op。
// 夹具用真实子进程取「活 pid / 死 pid」，不用 mock——判据 process.kill(pid, 0)
// 的行为本身就是被测对象。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  acquireDaemonLock,
  isDaemonPidAlive,
  readDaemonPidFile,
  releaseDaemonLock,
} from '../../../../src/host/daemon/daemonLock';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-daemon-lock-'));
  tempDirs.push(dir);
  return dir;
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
      if (child.pid && isDaemonPidAlive(child.pid)) {
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
      expect(readDaemonPidFile(dataDir)).toBe(winner.pid);
    } finally {
      await winner.stop();
    }
  });

  it('活 pid 持锁时让位，不抢（第二个实例退出路径的判据）', async () => {
    const dataDir = makeTempDir();
    const live = await spawnLivePid();
    try {
      fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(live.pid));
      const result = acquireDaemonLock(dataDir, 222);
      expect(result).toEqual({ acquired: false, existingPid: live.pid });
      // 锁文件原样保留，归属仍是活着的持有者。
      expect(readDaemonPidFile(dataDir)).toBe(live.pid);
    } finally {
      await live.stop();
    }
  });

  it('死 pid（陈旧锁）被接管（ADR-083 ①）', async () => {
    const dataDir = makeTempDir();
    const deadPid = await spawnDeadPid();
    expect(isDaemonPidAlive(deadPid)).toBe(false);
    fs.writeFileSync(path.join(dataDir, 'daemon.pid'), String(deadPid));
    const result = acquireDaemonLock(dataDir, 333);
    expect(result).toEqual({ acquired: true, pid: 333 });
    expect(readDaemonPidFile(dataDir)).toBe(333);
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
  it('释放后下一个实例可以获取；无文件时 no-op 不抛', () => {
    const dataDir = makeTempDir();
    expect(acquireDaemonLock(dataDir, 111)).toEqual({ acquired: true, pid: 111 });
    releaseDaemonLock(dataDir);
    expect(readDaemonPidFile(dataDir)).toBeNull();
    expect(acquireDaemonLock(dataDir, 222)).toEqual({ acquired: true, pid: 222 });
    expect(() => releaseDaemonLock(dataDir)).not.toThrow();
  });
});
