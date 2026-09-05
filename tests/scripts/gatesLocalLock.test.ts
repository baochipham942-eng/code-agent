import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- gate tooling is intentionally implemented as dependency-free ESM.
import { acquireLock } from '../../scripts/lib/gates-local-lock.mjs';

const tempDirs: string[] = [];

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-local-lock-'));
  tempDirs.push(dir);
  return path.join(dir, 'nested', 'gates-local.lock');
}

/** 找一个确定不存在的 pid，用来伪造「持锁者已死」的陈旧锁。 */
function deadPid(): number {
  for (let pid = 2 ** 21; pid > 2; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('找不到空闲 pid');
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('gates:local 单机互斥锁', () => {
  it('拿到锁后写入持锁者身份，release 后锁文件消失', () => {
    const lockPath = tempLockPath();
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, log: () => {} });

    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(holder.pid).toBe(process.pid);
    expect(holder.cwd).toBe(process.cwd());
    expect(Number.isNaN(Date.parse(holder.startedAt))).toBe(false);

    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('锁被活着的进程占着时排队等待，等到超时抛错——绝不放行', () => {
    const lockPath = tempLockPath();
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, log: () => {} });

    // 持锁者是本进程（必然活着），第二次进来只能排队，直到 waitMs 用尽。
    const startedAt = Date.now();
    expect(() => acquireLock({ lockPath, waitMs: 200, pollMs: 10, log: () => {} }))
      .toThrow(/拿不到锁/);
    // 真的等过，不是立刻返回
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    // 等待期间没有把别人的锁抢走
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);

    release();
  });

  it('持锁进程已死的陈旧锁被回收，不会把机器永久锁死', () => {
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid(),
      cwd: '/tmp/wt-已经不在了',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    }));

    const notices: string[] = [];
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, log: (m: string) => notices.push(m) });

    expect(notices.join('\n')).toMatch(/回收陈旧锁/);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('锁文件内容损坏时同样按陈旧处理，不是崩在 JSON.parse 上', () => {
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '这不是 JSON');

    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, log: () => {} });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('锁文件一出现就带完整身份，且不留临时文件', () => {
    // 防回归到「先 openSync(wx) 建空文件、再 writeFileSync 写内容」：那个中间态会被并发进程
    // 读成空内容 ⇒ 当陈旧锁删掉一把有效的锁 ⇒ 两条门同时开跑（09-05 ai-review 抓出）。
    const lockPath = tempLockPath();

    // 原子性来自 link（目标已存在即 EEXIST），所以直接咬住它：改回 openSync(lockPath,'wx')
    // 那种「先建空文件再写」的实现，这条断言立刻红。
    const link = vi.spyOn(fs, 'linkSync');
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, log: () => {} });
    expect(link).toHaveBeenCalledWith(expect.stringContaining('staging'), lockPath);
    link.mockRestore();

    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(holder.pid).toBe(process.pid);
    // staging 文件必须已经清掉，否则锁目录会随失败次数堆垃圾
    const leftovers = fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes('staging'));
    expect(leftovers).toEqual([]);

    release();
  });

  it('回收陈旧锁时校验身份：不会误删别人在这中间建好的有效锁', () => {
    // 竞态序列：本进程判定锁陈旧 → 另一个进程抢先回收并建了自己的新锁 → 本进程这一刀
    // 不能砍在那把新锁上。无校验的实现（直接 unlink 锁路径）会砍中，然后两条门同时开跑。
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid(),
      cwd: '/tmp/已经死了',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    }));

    const freshHolder = { pid: process.pid, cwd: '/tmp/别人刚拿到的锁', startedAt: new Date().toISOString() };
    const realRename = fs.renameSync.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!injected && from === lockPath) {
        injected = true;
        // 就在我们动手之前，别人回收了旧锁并建好了自己的新锁
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify(freshHolder));
      }
      realRename(from as string, to as string);
    });

    try {
      expect(() => acquireLock({ lockPath, waitMs: 300, pollMs: 10, log: () => {} }))
        .toThrow(/拿不到锁/);
      // 别人那把锁必须完好无损
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).cwd).toBe('/tmp/别人刚拿到的锁');
    } finally {
      rename.mockRestore();
    }
  });

  it('release 只删自己的锁：锁已被别人接管时不误删', () => {
    const lockPath = tempLockPath();
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, log: () => {} });

    // 模拟陈旧回收后锁易主
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, cwd: '/tmp/别人', startedAt: new Date().toISOString() }));
    release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid + 1);
  });
});
