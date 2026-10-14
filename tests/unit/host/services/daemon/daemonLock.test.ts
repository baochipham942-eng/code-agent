// ============================================================================
// daemonLock 单测（ADR-083 ①）：pid 文件 + 单实例锁 + pid 复用防线
//   - 两个实例并发抢锁：'wx' 原子创建保证只有一个赢；输家拿到赢家的 pid 让位。
//   - 活 pid 持锁（标记吻合且命令行含 node = owned / 无标记 = unknown）：第二个
//     实例让位，不抢。
//   - 死 pid（陈旧锁）、标记不符的活 pid、标记吻合但命令行不含 node 的活 pid
//     （pid 已被复用 = foreign）：接管成功。
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
  isDaemonLockSupported,
  readDaemonPidRecord,
  releaseDaemonLock,
} from '../../../../../src/host/services/daemon/daemonLock';
import { WEB_DAEMON } from '../../../../../src/shared/constants/webServer';

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

/** 起一个常驻但**不是 node** 的子进程（/bin/sleep）：命令行不含 node，用来造
 * 「启动标记吻合、但 pid 已归非 node 进程」的身份不符现场（返修 Important 2）。 */
function spawnNonNodePid(): Promise<{ pid: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    child.on('error', reject);
    const ready = setInterval(() => {
      if (child.pid && isAlive(child.pid)) {
        clearInterval(ready);
        resolve({
          pid: child.pid,
          stop: () => new Promise((done) => {
            child.once('exit', () => done());
            child.kill('SIGKILL');
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
      // 标记吻合 = owned（就是写文件的守护；node 子进程，命令行含 node）
      expect(inspectDaemonPid({ pid: live.pid, startTime: psLstart(live.pid) })).toBe('owned');
      // 标记不符 = foreign（pid 已被复用，不是写文件的那个进程）
      expect(inspectDaemonPid({ pid: live.pid, startTime: 'Fri Jan  1 00:00:00 1970' })).toBe('foreign');
      // 无标记（旧版纯 pid 文件）= unknown（活着但证明不了身份）
      expect(inspectDaemonPid({ pid: live.pid, startTime: null })).toBe('unknown');
    } finally {
      await live.stop();
    }

    // 标记吻合但命令行不含 node（返修 Important 2）：lstart 撞上同一秒内复用该
    // pid 的非 node 进程，仍按 pid 已被复用 = foreign 处理，绝不认作守护。
    const nonNode = await spawnNonNodePid();
    try {
      expect(psLstart(nonNode.pid)).not.toContain('node');
      expect(inspectDaemonPid({ pid: nonNode.pid, startTime: psLstart(nonNode.pid) })).toBe('foreign');
    } finally {
      await nonNode.stop();
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

  it('活 pid、启动标记吻合但命令行不含 node（pid 已归非 node 进程）：接管，不让位', async () => {
    const dataDir = makeTempDir();
    const nonNode = await spawnNonNodePid();
    try {
      writePidRecord(dataDir, nonNode.pid, psLstart(nonNode.pid));
      const result = acquireDaemonLock(dataDir, 333);
      expect(result).toEqual({ acquired: true, pid: 333 });
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(333);
    } finally {
      await nonNode.stop();
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

  it.each(['', '{"pid":'])('过期的空/截断锁文件可被接管并重写记录（ADR-083 r6）：%j', (raw) => {
    const dataDir = makeTempDir();
    const pidPath = path.join(dataDir, 'daemon.pid');
    fs.writeFileSync(pidPath, raw);
    const staleAt = new Date(Date.now() - WEB_DAEMON.UNREADABLE_PID_GRACE_MS - 1_000);
    fs.utimesSync(pidPath, staleAt, staleAt);

    const result = acquireDaemonLock(dataDir, 445);
    expect(result).toEqual({ acquired: true, pid: 445 });
    expect(readDaemonPidRecord(dataDir)?.pid).toBe(445);
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

// ── win32 平台裁剪（返修 2026-10-13 Important 2）────────────────────────────
// win32 没有进程身份源（readProcessIdentity 返 null）→ 每个活 pid 都是 unknown →
// 硬杀 + pid 复用后 acquire 永远让位，app 再也起不来，CLI 也清不掉。裁剪：win32
// 根本不取锁——acquire 直接成功且不写 daemon.pid，release no-op。
describe('win32：不取锁也不执行锁（平台裁剪）', () => {
  it('acquire 直接成功：活 pid 持锁文件在场也不让位，且不写/不碰 daemon.pid', async () => {
    const dataDir = makeTempDir();
    const live = await spawnLivePid();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // 现场还原返修前的死锁：pid 文件指着一个活进程（win32 下身份永远 unknown）。
      writePidRecord(dataDir, live.pid, psLstart(live.pid));
      expect(acquireDaemonLock(dataDir, 555)).toEqual({ acquired: true, pid: 555 });
      // 「writes nothing」：文件还是持锁者那一份，没被改写、没被删。
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(live.pid);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      await live.stop();
    }
  });

  it('release 是 no-op：本进程写的无标记记录也不删（win32 下没人取锁，无锁可放）', () => {
    const dataDir = makeTempDir();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      writePidRecord(dataDir, process.pid, null);
      releaseDaemonLock(dataDir);
      expect(readDaemonPidRecord(dataDir)?.pid).toBe(process.pid);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('isDaemonLockSupported：mac/linux 真、win32 假（平台判据单一真源）', () => {
    const originalPlatform = process.platform;
    try {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        expect(isDaemonLockSupported()).toBe(platform !== 'win32');
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
