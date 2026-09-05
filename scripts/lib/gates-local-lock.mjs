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

/**
 * 从同一个 fd 读内容和 inode——分别 readFileSync + statSync 的话，两次调用之间锁文件可能
 * 已经被换掉，拿到的身份和 inode 就不是同一把锁的了。
 */
function readHolder(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'r');
    const ino = fs.fstatSync(fd).ino;
    const raw = fs.readFileSync(fd, 'utf8');
    try {
      return { ...JSON.parse(raw), ino };
    } catch {
      // 文件在、内容坏。必须把 inode 带出去，否则回收时拿不到比对基准，
      // 会在「挂回去 → 仍然坏 → 再回收」之间空转（09-05 首版实测把测试跑成死循环）。
      return { ino, corrupt: true };
    }
  } catch {
    return null; // 文件根本不在
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关或已删，无所谓 */
      }
    }
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
      if (!holder) continue; // 锁刚被释放，直接回去抢

      if (holder.corrupt || !holderAlive(holder.pid)) {
        // 陈旧锁（持锁进程已死，或文件损坏）。
        //
        // 🔴 这里**故意不自动回收**。自动回收要做的是「确认它陈旧」和「删掉它」两步，而
        // POSIX 没有 compare-and-delete —— 两步之间那把锁可能已被别人回收、别人已建好新锁，
        // 这一刀就砍在有效锁上。09-05 试过两版补救（inode 校验 + rename 墓碑 + link 还原），
        // 每版都被 ai-review 抓出新的竞态形态，最后一版还剩一个三方窗口搬不走。
        //
        // 账很清楚：自动回收换来的全部收益，是「进程被 kill 之后省一次手动 rm」；
        // 代价是这把锁的核心承诺（同机只有一条门）带一个静默失效的洞。所以砍掉它。
        // 死进程不会自己释放锁，等下去没有意义 —— 直接 fail-loud，把命令给人。
        if (process.env.GATES_LOCAL_FORCE_UNLOCK === '1') {
          log('[gates:local] GATES_LOCAL_FORCE_UNLOCK=1，按人工授权强行清锁');
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* 别人先清了 */
          }
          continue;
        }
        throw new Error(
          `[gates:local] 锁被一个已经不在的进程占着（pid ${holder.pid ?? '?'}${holder.corrupt ? '，且锁文件内容已损坏' : ''}）\n`
          + `  确认机器上确实没有门在跑（pgrep -f 'scripts/gates-local.mjs'），然后清掉它：\n`
          + `    rm ${lockPath}\n`
          + '  或者用 GATES_LOCAL_FORCE_UNLOCK=1 重跑本命令（等于你替它签字：确实没人在跑）。\n'
          + '  🔴 不自动清是有意的：确认陈旧与删除之间没有原子操作，自动清会误删别人刚建的有效锁。',
        );
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
