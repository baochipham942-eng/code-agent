// ============================================================================
// Shell Exit — ADR-083 壳退出后的驻留判据（平台分叉）
// ============================================================================
// stdin 管道断开的含义按平台分叉：
//   - macOS/Linux：只有 Tauri 壳退出/崩溃才会关 stdin——「没人再杀我们」，
//     去留交给空闲判据（shouldDaemonExit）：全空闲随壳退出，忙则留守。
//   - Windows：Rust terminate_child（更新流程/壳退出）正是用「关 stdin 写端」
//     表示「请退出」，wait_then_force_kill 3s 后 TerminateProcess 兜底
//     （src-tauri main.rs 的 not(unix) 分支）。stdin EOF 在那边是停机指令，
//     不是驻留信号——忙时驻留会把优雅窗耗在被硬杀上（graceful 退化为
//     hard kill）。win32 维持 origin/main 行为：EOF 一律立即优雅停机。
// 纯函数：platform 由调用方传入（process.platform），便于表驱动单测。
// ============================================================================

import { shouldDaemonExit, type DaemonIdleSnapshot } from './daemonIdle';

/** stdin EOF 后 daemon 是否留守（false = 走优雅停机）。win32 一律 false；
 * 其余平台拿不到空闲快照（app 未接线）也按不留守处理，与「无快照随壳退出」
 * 的既有口径一致。 */
export function shouldStayResidentAfterShellExit(
  platform: NodeJS.Platform,
  snapshot: DaemonIdleSnapshot | undefined,
): boolean {
  if (platform === 'win32') return false;
  return snapshot !== undefined && !shouldDaemonExit(snapshot);
}
