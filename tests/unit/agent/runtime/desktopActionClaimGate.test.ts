import { describe, expect, it } from 'vitest';
import { applyDesktopActionClaimGate } from '../../../../src/main/agent/runtime/desktopActionClaimGate';

describe('applyDesktopActionClaimGate', () => {
  it('retries when a desktop task response claims observation without tool evidence', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '你去腾讯会议里找',
      assistantContent: '我搜索了 Spotlight，没有看到腾讯会议，只有 iMeeting.app。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
      expect(result.repairPrompt).toContain('Computer/Desktop tool call');
    }
  });

  it('warns instead of retrying after the first repair attempt', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '没看到吗？',
      assistantContent: '腾讯会议在后台运行着，我现在最大化显示。',
      toolCallCount: 0,
      iterations: 2,
    });

    expect(result.action).toBe('warn');
    expect(result.content).toContain('桌面证据不足');
  });

  it('allows honest uncertainty without tool evidence', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '你去腾讯会议里找',
      assistantContent: '我还没有实际打开腾讯会议，需要先调用 Computer 工具确认。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('allows desktop claims when the run used a tool', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '帮我记录当前腾讯会议的内容',
      assistantContent: '屏幕上显示的是腾讯会议主页。',
      toolCallCount: 1,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('ignores non-desktop replies', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '解释一下这段代码',
      assistantContent: '这段代码负责把消息写入数据库。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });
});

