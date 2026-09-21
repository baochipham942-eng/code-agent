import { describe, expect, it } from 'vitest';
import { resolveChatOriginKind } from '../../../src/cli/commands/chatOriginKind';

// issue #1994：管道 / --json 的 chat 没有人应答 AskUserQuestion，必须按 headless
// 入口声明 originKind（→ unattendedTurn → AskUserQuestion 收出工具面）；
// TTY 交互（Ink TUI / readline）不声明，交互行为不变。
describe('resolveChatOriginKind', () => {
  it('stdin 非 TTY（管道喂入）→ headless', () => {
    expect(resolveChatOriginKind({ isJsonMode: false, stdinIsTTY: false })).toBe('headless');
  });

  it('--json 模式即使 stdin 是 TTY 也按 headless（输出给机器消费）', () => {
    expect(resolveChatOriginKind({ isJsonMode: true, stdinIsTTY: true })).toBe('headless');
    expect(resolveChatOriginKind({ isJsonMode: true, stdinIsTTY: false })).toBe('headless');
  });

  it('TTY 交互 chat 不声明 originKind（界面会话 = 真人手动）', () => {
    expect(resolveChatOriginKind({ isJsonMode: false, stdinIsTTY: true })).toBeUndefined();
  });
});
