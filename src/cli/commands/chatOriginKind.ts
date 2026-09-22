// ============================================================================
// resolveChatOriginKind — chat 入口的 originKind 判定（issue #1994）
//
// 管道喂入 / --json 的 chat 没有人守在终端前，AskUserQuestion 永远无人应答——
// 按 headless 入口声明 originKind，复用 originKind → unattendedTurn 现有链路
// 把 AskUserQuestion 收出工具面（见 host/agent/runtime/toolRunPolicy.ts）。
// TTY 交互（Ink TUI / readline）不声明，交互行为不变。
// ============================================================================

import type { SessionOriginKind } from '../../shared/contract/session';

export function resolveChatOriginKind(input: {
  isJsonMode: boolean;
  stdinIsTTY: boolean;
}): SessionOriginKind | undefined {
  return input.isJsonMode || !input.stdinIsTTY ? 'headless' : undefined;
}
