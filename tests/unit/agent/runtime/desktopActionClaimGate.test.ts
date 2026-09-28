import { describe, expect, it } from 'vitest';
import { applyDesktopActionClaimGate } from '../../../../src/host/agent/runtime/desktopActionClaimGate';

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
      latestUserMessage: '你去腾讯会议里找',
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

  it('allows appshot-backed screen observations without a desktop tool call', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '<appshot app="com.apple.finder" name="Finder">Downloads file list</appshot>',
      assistantContent: '屏幕上显示的是 Finder 的 Downloads 文件列表。',
      toolCallCount: 0,
      iterations: 1,
      hasDesktopEvidence: true,
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

  it('does not retry a Chinese prose reply that uses observation words without a desktop request', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '写一篇约 8000 字的中文散文，主题是湖边小镇的四季。不要调用任何工具。',
      assistantContent: '那年春天我打开了窗口，看到了湖面上的晨雾，后来在老街找到一盏还亮着的灯。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith('【桌面证据不足】')).toBe(false);
  });

  it('does not retry an English essay that mentions windows and finding things', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: 'Write an 800-word English essay about the four seasons in a lakeside town. Do not call any tools.',
      assistantContent: 'In spring I opened the window, saw the mist over the lake, and finally found the old lamp still glowing.',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith('【桌面证据不足】')).toBe(false);
  });

  it('does not retry a translation reply whose source text contains observation words', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '请把下面译成英文：春天我打开了窗口，看到了湖面，终于找到了那家小店。',
      assistantContent: 'In spring I opened the window. 我打开了窗口，看到了湖面，终于找到了那家小店。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith('【桌面证据不足】')).toBe(false);
  });

  it('does not retry a code explanation that uses 打开了/窗口/找到/看到了', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '解释一下这段代码',
      assistantContent: '这段代码打开了设置窗口，找到配置项之后把结果写回去。我看到了这里的边界处理。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
    expect(result.content.startsWith('【桌面证据不足】')).toBe(false);
  });

  it('does not retry a summary that retells observation-like sentences', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '请总结这篇文章的大意',
      assistantContent: '作者写他打开了窗口，看到了湖，后来找到回家的路。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('does not retry a Q&A reply that uses 窗口/看到了/找到 as metaphors', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '什么是闭包？',
      assistantContent: '闭包能记住定义时的窗口变量。我看到了这个问题的核心，找到了最简例子：函数打开了外层作用域。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });

  it('retries when the user asked to open Notes and the reply claims it was done', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '打开备忘录',
      assistantContent: '我已经打开了备忘录，看到了里面的清单。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
    }
  });

  it('retries when the user asked for a screenshot and the reply claims it was seen', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '截个屏看看',
      assistantContent: '我截图了，屏幕上显示的是桌面，看到了当前窗口。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
    }
  });

  it('retries when the user asked to click Tencent Meeting and the reply claims the click', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '点一下腾讯会议',
      assistantContent: '我点击了腾讯会议，窗口已经在前台。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('retry');
    if (result.action === 'retry') {
      expect(result.reason).toBe('desktop_action_claim_without_tool_evidence');
    }
  });

  it('still allows honest uncertainty on a desktop request to open Notes', () => {
    const result = applyDesktopActionClaimGate({
      latestUserMessage: '打开备忘录',
      assistantContent: '我还没有打开备忘录，需要先调用 Computer 工具确认。',
      toolCallCount: 0,
      iterations: 1,
    });

    expect(result.action).toBe('none');
  });
});
