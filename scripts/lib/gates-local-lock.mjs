import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * 单机互斥：同一台机器上只许一条 gates:local 在跑。
 *
 * 2026-09-03 实付（N-GATES-LOCAL-LOCK）：五个工人各自 `pgrep` 看到空窗就发车，于是**同一个
 * 空窗一起起跑**——wt-connector-inchat 与 wt-promptgate 撞在一起，CDCHAIN 两遍 42 格门都在
 * 35/42 那格浏览器用例上因 5173 端口动态 import 争用假红，然后 fail-closed 停工。
 * 「先 pgrep 再跑」这类**检查与动作分离**的协议天生带竞态窗口，补不严，只能换成真锁。
 *
 * 所以门自己排队：拿不到锁就阻塞等，并把持锁者是谁打出来（别让人对着不动的终端猜）。
 * 陈旧锁（持锁进程已死，如 kill -9 / 断电 / 面板直接关窗）自动回收，否则一次崩溃锁死整台机器。
 */

export const defaultLockPath = path.join(os.homedir(), '.ship', 'locks', 'gates-local.lock');

function sleepSync(ms) {
  // 同步睡眠：调用方通篇 spawnSync，不为等锁引入 async，也不为它起子进程。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHolder(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function holderAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程还在，只是不归当前用户管
    return error.code === 'EPERM';
  }
}

function heldFor(holder) {
  const started = Date.parse(holder?.startedAt ?? '');
  return Number.isNaN(started) ? '?' : `${((Date.now() - started) / 60_000).toFixed(0)}m`;
}

/**
 * 拿锁，拿不到就排队等。返回 release()。
 * 等到超时**抛错**而不是放行——静默放行正是这道门要修的病。
 */
export function acquireLock({
  lockPath = process.env.GATES_LOCAL_LOCK_PATH || defaultLockPath,
  waitMs = Number(process.env.GATES_LOCAL_LOCK_WAIT_MINUTES || 90) * 60_000,
  pollMs = 5_000,
  log = console.log,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  const waitStartedAt = Date.now();
  let announced = false;
  let lastNotice = 0;

  for (;;) {
    try {
      // 🔴 不能用 openSync(lockPath,'wx') 再 writeFileSync：那样锁文件会有一段「已存在但还是
      // 空的」中间态，另一个进程正好在这一刻读到空内容 ⇒ 判成陈旧锁 ⇒ 把一把有效的锁删掉，
      // 两条门同时开跑（09-05 ai-review 抓出，正是本单要消灭的那个形状）。
      // 改成：先把带身份的内容写进临时文件，再用 link 原子地挂到锁路径上——link 在目标已存在
      // 时失败（EEXIST），所以「锁文件出现」与「锁文件有内容」是同一个瞬间，没有中间态。
      const stagingPath = `${lockPath}.${process.pid}.staging`;
      fs.writeFileSync(stagingPath, JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      }));
      try {
        fs.linkSync(stagingPath, lockPath);
      } finally {
        fs.unlinkSync(stagingPath);
      }

      if (announced) {
        log(`[gates:local] 拿到锁，开跑（排队 ${((Date.now() - waitStartedAt) / 60_000).toFixed(1)}m）`);
      }

      return function release() {
        // 只删自己的锁：陈旧回收可能已经把它判给了别人。
        try {
          if (readHolder(lockPath)?.pid === process.pid) fs.unlinkSync(lockPath);
        } catch {
          /* 释放失败不该盖掉门本身的退出码；陈旧回收会兜底 */
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const holder = readHolder(lockPath);
      if (!holder || !holderAlive(holder.pid)) {
        // 走到这里只可能是真的损坏（link 保证了不存在「已建但未写入」的中间态）。
        // ponytail: 判定陈旧与 unlink 之间仍有竞态窗口，但后果只是两边都回到 linkSync，
        // 仍然只有一个能成功——不值得为它再加一层协调。
        log(`[gates:local] 回收陈旧锁（持有者 pid ${holder?.pid ?? '?'} 已不在）`);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* 别人先回收了，下一轮重试 */
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `[gates:local] 排队 ${(waitMs / 60_000).toFixed(0)}m 仍拿不到锁，退出（不静默放行）\n`
          + `  持锁者：pid ${holder.pid} · ${holder.cwd} · 已跑 ${heldFor(holder)}\n`
          + '  它卡住了就去看那条；确认已死就 kill 掉，锁会被下一条自动回收。',
        );
      }

      if (!announced) {
        log('[gates:local] 机器上已有一条门在跑，排队等待（不是卡死）：');
        log(`  持锁者：pid ${holder.pid} · ${holder.cwd} · 已跑 ${heldFor(holder)}`);
        announced = true;
        lastNotice = Date.now();
      } else if (Date.now() - lastNotice > 300_000) {
        log(`[gates:local] 仍在排队 ${((Date.now() - waitStartedAt) / 60_000).toFixed(0)}m（持锁者 pid ${holder.pid}，已跑 ${heldFor(holder)}）`);
        lastNotice = Date.now();
      }

      sleepSync(pollMs);
    }
  }
}
