// 子进程死活判定 —— 供 acceptance smoke 共用。
//
// 为什么单独抽出来：`child.exitCode !== null` 是**错的**存活判定。
// 子进程被信号打死时（SIGABRT / SIGSEGV / SIGKILL / 被我们 SIGTERM），
// Node 把 exitCode 保持为 null，信号落在 signalCode 上。只看 exitCode 的轮询
// 会把「已经崩了的子进程」当成「还在启动中」，一路空转到超时，
// 最后报一个与真因无关的 timeout —— 真正的崩溃栈被埋在输出里，
// 而报错说的是「等超时了」。
//
// 2026-08-07 实测：renderer hot-update smoke 在 CI 上撞 better-sqlite3 的
// V8 断言（SIGABRT），就是被这个谓词漏掉，60 秒后以 timeout 形式暴露。

import type { ChildProcess } from 'child_process';

/** 子进程是否已经终止（正常退出或被信号打死）。 */
export function isChildGone(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** 供报错/日志使用的终止描述：退出码和信号都要说，否则分不清 abort 和正常退出。 */
export function describeChildExit(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): string {
  if (!isChildGone(child)) return 'still running';
  return `exitCode=${child.exitCode ?? '-'} signal=${child.signalCode ?? '-'}`;
}

/** 是否是「非我方预期」的终止：既不是干净退出，也不是我们发的 SIGTERM。 */
export function isAbnormalExit(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  if (!isChildGone(child)) return false;
  if (child.exitCode === 0) return false;
  if (child.exitCode === null && child.signalCode === 'SIGTERM') return false;
  return true;
}
