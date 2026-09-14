/**
 * 项目/会话 sheet 等「电脑里的库」时的形态（2026-09-14 build 34 反馈③）。已断连时进 sheet
 * 不许先转圈——refreshLibrary 在非 connected 下直接 return，圈是无限期的；connecting 仍算
 * 等待：那时真有一场重连在飞，直接报「连不上」是谎报，超时兜底会收口。独立模块照
 * connectionCopy/taskStatusCopy 的先例，让这条分支可单测。
 */
export function sheetLibraryStatus(
  companion: { library: unknown; status: string; libraryError: boolean },
  timedOut: boolean,
): 'ready' | 'waiting' | 'unreachable' {
  if (companion.library) return 'ready';
  if (companion.libraryError || timedOut || (companion.status !== 'connected' && companion.status !== 'connecting')) return 'unreachable';
  return 'waiting';
}
