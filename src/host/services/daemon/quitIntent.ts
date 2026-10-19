// ============================================================================
// Quit Intent — ADR-083 壳声明的退出意图（none / background / stop）
// ============================================================================
// 壳在退进程之前 POST /api/quit-intent 声明本次退出是「后台继续」（background）
// 还是「停止并退出」（stop）。去留判据据此分叉（ADR-083 拍板 2026-10-18）：
//   - background：armed schedules 才构成留守原因（daemonIdle.daemonStayReasons），
//     同时 arm detach（win32 把 stdin EOF 从「请退出」摘掉，兼容旧
//     /quit-guard/detach 的合同——旧路由是这个 setter 的别名）。
//   - stop：把下一次 stdin EOF 变成全平台停机指令（stdinEofIsQuitCommand），
//     忙也一样——先照常排空在跑 run，再优雅停机（webServer.shutdown）。
//   - none（无声明，壳崩了/被杀）：armed schedules 单独永不留守，不留隐形 daemon。
// ============================================================================

import type { DaemonQuitIntent } from './daemonIdle';
import { armBackgroundContinueDetach } from './shellExit';

export type DaemonQuitIntentChoice = 'background' | 'stop';

let daemonQuitIntent: DaemonQuitIntent = 'none';
const intentListeners = new Set<() => void>();

/** 壳声明退出意图。background 同时 arm detach（win32 EOF 停机指令摘除）。 */
export function setDaemonQuitIntent(choice: DaemonQuitIntentChoice): void {
  if (daemonQuitIntent === choice) return;
  daemonQuitIntent = choice;
  if (choice === 'background') armBackgroundContinueDetach();
  for (const listener of intentListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[QuitIntent] listener failed:', error);
    }
  }
}

export function getDaemonQuitIntent(): DaemonQuitIntent {
  return daemonQuitIntent;
}

/** 意图变化通知（daemon 状态文件据此重写）。返回取消订阅。 */
export function onDaemonQuitIntentChange(listener: () => void): () => void {
  intentListeners.add(listener);
  return () => intentListeners.delete(listener);
}
