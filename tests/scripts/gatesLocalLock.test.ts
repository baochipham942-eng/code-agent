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
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} });

    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(holder.pid).toBe(process.pid);
    expect(holder.cwd).toBe(process.cwd());
    expect(Number.isNaN(Date.parse(holder.startedAt))).toBe(false);

    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('锁被活着的进程占着时排队等待，等到超时抛错——绝不放行', () => {
    const lockPath = tempLockPath();
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} });

    // 持锁者是本进程（必然活着），第二次进来只能排队，直到 waitMs 用尽。
    const startedAt = Date.now();
    expect(() => acquireLock({ lockPath, waitMs: 200, pollMs: 10, ownerPattern: 'node', log: () => {} }))
      .toThrow(/拿不到锁/);
    // 真的等过，不是立刻返回
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    // 等待期间没有把别人的锁抢走
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);

    release();
  });

  it('持锁进程已死时 fail-loud 并给出清锁命令，绝不自动删别人的锁', () => {
    // 自动回收要「确认陈旧」+「删除」两步，POSIX 没有 compare-and-delete，两步之间
    // 那把锁可能已被别人回收并建好新锁 —— 自动删就是砍在有效锁上。所以这里只报不删。
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const stale = {
      pid: deadPid(),
      cwd: '/tmp/wt-已经不在了',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));

    expect(() => acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} }))
      .toThrow(/已经不在的进程占着/);
    // 锁必须原样留着，且指引里要带真实路径
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(stale.pid);
    expect(() => acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} }))
      .toThrow(new RegExp(`rm ${lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('人工授权 GATES_LOCAL_FORCE_UNLOCK=1 时才清陈旧锁', () => {
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid(), cwd: '/tmp/死了', startedAt: new Date().toISOString(),
    }));

    const prev = process.env.GATES_LOCAL_FORCE_UNLOCK;
    process.env.GATES_LOCAL_FORCE_UNLOCK = '1';
    try {
      const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} });
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
      release();
    } finally {
      if (prev === undefined) delete process.env.GATES_LOCAL_FORCE_UNLOCK;
      else process.env.GATES_LOCAL_FORCE_UNLOCK = prev;
    }
  });

  it('锁文件内容损坏时也走 fail-loud，不是崩在 JSON.parse 上、也不自动删', () => {
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '这不是 JSON');

    expect(() => acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} }))
      .toThrow(/锁文件内容已损坏/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('这不是 JSON');
  });

  it('锁文件一出现就带完整身份，且不留临时文件', () => {
    // 防回归到「先 openSync(wx) 建空文件、再 writeFileSync 写内容」：那个中间态会被并发进程
    // 读成空内容 ⇒ 当陈旧锁删掉一把有效的锁 ⇒ 两条门同时开跑（09-05 ai-review 抓出）。
    const lockPath = tempLockPath();

    // 原子性来自 link（目标已存在即 EEXIST），所以直接咬住它：改回 openSync(lockPath,'wx')
    // 那种「先建空文件再写」的实现，这条断言立刻红。
    const link = vi.spyOn(fs, 'linkSync');
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} });
    expect(link).toHaveBeenCalledWith(expect.stringContaining('staging'), lockPath);
    link.mockRestore();

    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(holder.pid).toBe(process.pid);
    // staging 文件必须已经清掉，否则锁目录会随失败次数堆垃圾
    const leftovers = fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes('staging'));
    expect(leftovers).toEqual([]);

    release();
  });

  it('活性判据自验：pid 活着但不是门进程，按陈旧处理（防 pid 复用）', () => {
    // 只看 process.kill(pid,0) 的实现，会把「pid 被无关进程复用」当成门还在跑，
    // 于是所有人白等到超时。真阳=当前进程命令行含 node；真阴=同一个 pid 换个匹配串。
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString(),
    }));

    // 真阳：命令行匹配得上 ⇒ 认作还活着 ⇒ 排队到超时
    expect(() => acquireLock({ lockPath, waitMs: 150, pollMs: 10, ownerPattern: 'node', log: () => {} }))
      .toThrow(/拿不到锁/);
    // 真阴：同一个活 pid，但命令行对不上门 ⇒ 判陈旧 ⇒ fail-loud 给清锁指引
    expect(() => acquireLock({ lockPath, waitMs: 150, pollMs: 10, ownerPattern: '绝不会出现在命令行里的串', log: () => {} }))
      .toThrow(/已经不在的进程占着/);
  });

  it('GATES_LOCAL_LOCK_WAIT_MINUTES 非正数直接报错，不让 deadline 变 NaN', () => {
    const prev = process.env.GATES_LOCAL_LOCK_WAIT_MINUTES;
    try {
      for (const bad of ['abc', '0', '-5']) {
        process.env.GATES_LOCAL_LOCK_WAIT_MINUTES = bad;
        expect(() => acquireLock({ lockPath: tempLockPath(), pollMs: 10, ownerPattern: 'node', log: () => {} }))
          .toThrow(/必须是正数/);
      }
      // 空串走默认值，不报错
      process.env.GATES_LOCAL_LOCK_WAIT_MINUTES = '';
      const release = acquireLock({ lockPath: tempLockPath(), pollMs: 10, ownerPattern: 'node', log: () => {} });
      release();
    } finally {
      if (prev === undefined) delete process.env.GATES_LOCAL_LOCK_WAIT_MINUTES;
      else process.env.GATES_LOCAL_LOCK_WAIT_MINUTES = prev;
    }
  });

  it('release 只删自己的锁：锁已被别人接管时不误删', () => {
    const lockPath = tempLockPath();
    const release = acquireLock({ lockPath, waitMs: 1_000, pollMs: 10, ownerPattern: 'node', log: () => {} });

    // 模拟陈旧回收后锁易主
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, cwd: '/tmp/别人', startedAt: new Date().toISOString() }));
    release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid + 1);
  });
});
