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

/**
 * 回收陈旧锁。
 *
 * 🔴 不能直接 `unlinkSync(lockPath)`：判定陈旧到删除之间，那把锁可能已经被别人回收、
 * 并且别人已经建了自己的新锁——这一刀就把一把**有效的锁**删了，两条门同时开跑
 * （09-05 ai-review 第二次抓出，我在注释里第二次断言「没问题」，第二次判错）。
 *
 * POSIX 没有 compare-and-delete，但 rename 是原子的：先把锁 rename 到只有本进程知道的
 * 墓碑路径（只有一个进程能移走同一个 inode），再核对移走的 inode 是不是当初判定为陈旧的
 * 那一个。不是就用 link 原样挂回去（link 不覆盖，已有新锁时会 EEXIST，那就直接丢弃墓碑）。
 *
 * ponytail: 还原窗口里仍有一个三方竞态残留——A 判陈旧 → C 抢先回收并建锁 → A 移走了 C 的锁
 * → 在 A 挂回去之前 D 又建了锁，此时 C 与 D 会同时跑。需要四步精确交错，且每步都在微秒级窗口内；
 * 真要根除得换 flock（进程死了内核自动释放，没有回收这回事），Node 无内置绑定、要引依赖。
 * 这里明说残留，不再声称「没问题」。
 */
function reclaimStale(lockPath, expectedIno, log) {
  const tombstone = `${lockPath}.dead.${process.pid}`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch {
    return; // 别人先动了，回主循环重来
  }
  let movedIno;
  try {
    movedIno = fs.statSync(tombstone).ino;
  } catch {
    movedIno = undefined;
  }
  if (movedIno !== expectedIno) {
    // 移走的不是当初判定为陈旧的那把（有人在这中间重建了锁）——原样挂回去
    log('[gates:local] 回收时发现锁已易主，原样放回');
    try {
      fs.linkSync(tombstone, lockPath);
    } catch {
      /* 已经有更新的锁了，丢弃墓碑即可 */
    }
  }
  try {
    fs.unlinkSync(tombstone);
  } catch {
    /* 墓碑已不在 */
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
        // 内容读不出来只可能是真的损坏（link 保证了不存在「已建但未写入」的中间态）。
        log(`[gates:local] 回收陈旧锁（持有者 pid ${holder?.pid ?? '?'} 已不在）`);
        reclaimStale(lockPath, holder?.ino, log);
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
