// ============================================================================
// Shell Exit — ADR-083 壳退出后的驻留判据（平台分叉）
// ============================================================================
// stdin 管道断开的含义按平台分叉：
//   - macOS/Linux：只有 Tauri 壳退出/崩溃才会关 stdin——「没人再杀我们」，
//     去留交给空闲判据（shouldDaemonExit）：全空闲随壳退出，忙则留守。
//   - Windows：Rust terminate_child（停止并退出 / 更新）用「关 stdin 写端」
//     表示「请退出」，wait_then_force_kill 3s 后 TerminateProcess 兜底
//     （src-tauri main.rs 的 not(unix) 分支）。这条 EOF 是停机指令——忙时
//     驻留会把优雅窗耗在被硬杀上。默认 win32 仍立即优雅停机。
//   - Windows「后台继续」是例外：壳在退进程之前 POST /api/quit-guard/detach，
//     armBackgroundContinueDetach() 把「EOF = 停机指令」摘掉。随后的 EOF
//     与 macOS/Linux 一样交给空闲判据。停止并退出不会 arm，关 stdin 仍是停机。
// 纯函数：platform / detach 由调用方传入，便于表驱动单测。
// ============================================================================

import { shouldDaemonExit, type DaemonIdleSnapshot } from './daemonIdle';

interface DaemonExitRechecker {
  /** 标记 stdin 已断开并立即按当前空闲快照决定是否停机。 */
  onShellPipeClosed: () => boolean;
  /** 在壳已断开后由运行/审批终态事件调用；true 表示已触发停机。 */
  recheck: () => boolean;
}

let detachArmed = false;

/** 壳在退进程之前声明：接下来的 stdin EOF 是后台继续，不是 Windows 停机指令。 */
export function armBackgroundContinueDetach(): void {
  detachArmed = true;
}

export function backgroundContinueDetachArmed(): boolean {
  return detachArmed;
}

/** win32 且尚未 arm detach → stdin EOF 是停机指令。其余情况不是。 */
export function stdinEofIsQuitCommand(platform: NodeJS.Platform, detachArmedNow: boolean): boolean {
  return platform === 'win32' && !detachArmedNow;
}

/** stdin EOF 后 daemon 是否留守（false = 走优雅停机）。
 * `eofIsQuitCommand` 缺省按平台：win32 为 true（立即停机），其余为 false。
 * 后台继续把第三次参数传 false，win32 才改走空闲判据。
 * 拿不到空闲快照也按不留守处理，与「无快照随壳退出」的既有口径一致。 */
export function shouldStayResidentAfterShellExit(
  platform: NodeJS.Platform,
  snapshot: DaemonIdleSnapshot | undefined,
  eofIsQuitCommand = platform === 'win32',
): boolean {
  if (eofIsQuitCommand) return false;
  return snapshot !== undefined && !shouldDaemonExit(snapshot);
}

/**
 * 把壳断开后的去留判定变成可重复调用的事件钩子。
 *
 * 壳可能先于 run 终态退出：第一次检查只能决定“留守”，之后每个 idle
 * transition 都要再检查一次，否则 daemon 会永久持有 pid 锁和数据库。
 */
export function createDaemonExitRechecker(input: {
  platform: NodeJS.Platform;
  getSnapshot: () => DaemonIdleSnapshot | undefined;
  shutdown: () => void | Promise<void>;
  /** 缺省：win32 的 stdin EOF 是停机指令。后台继续把这个关掉。 */
  stdinEofIsQuitCommand?: () => boolean;
}): DaemonExitRechecker {
  let shellPipeAttached = true;
  let shutdownStarted = false;
  const eofIsQuitCommand = input.stdinEofIsQuitCommand ?? (() => input.platform === 'win32');

  const recheck = (): boolean => {
    if (shellPipeAttached || shutdownStarted) return false;
    const snapshot = input.getSnapshot();
    const shouldExit = eofIsQuitCommand()
      || snapshot === undefined
      || shouldDaemonExit(snapshot);
    if (!shouldExit) return false;
    shutdownStarted = true;
    void input.shutdown();
    return true;
  };

  return {
    onShellPipeClosed: () => {
      shellPipeAttached = false;
      return recheck();
    },
    recheck,
  };
}
