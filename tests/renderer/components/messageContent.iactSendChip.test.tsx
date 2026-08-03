// @vitest-environment jsdom
// ============================================================================
// IACT !send chip B+A 组合渲染（2026-08-02 拍板，设计稿 neo-iact-chip-design.html）：
// - 单 chip = A 轻链接：品牌青字 + dotted 下划线，无边框无底衬，点击仍 dispatch iact:send
// - 同段 ≥2 个 = B 选项行：正文降级纯文本，段后 ghost 按钮横排，首项品牌青
// - 跨段落各 1 个互不摘出；流式中途未写完的链接不触发选项行
// 发送链路（iact:send → ChatInput → iactChipConfirmation 模板）不在本测试范围、行为不变。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

// MarkdownRenderer 是 lazy + Suspense（fallback 为纯文本），需等核心加载完再断言。
async function renderAssistant(content: string) {
  const utils = render(<MessageContent content={content} isUser={false} messageId="assistant-1" />);
  await waitFor(() => {
    expect(utils.container.querySelector('p, [data-iact-options]')).toBeTruthy();
  });
  return utils;
}

/** 挂 iact:send 监听，返回收集到的 detail 列表。 */
function collectIactSend(): string[] {
  const received: string[] = [];
  window.addEventListener('iact:send', (e) => {
    received.push((e as CustomEvent<string>).detail);
  });
  return received;
}

describe('IACT !send chip：B+A 组合', () => {
  afterEach(() => cleanup());

  it('单 chip 渲染为轻链接：带标记、有 dotted 下划线、无边框，点击 dispatch iact:send', async () => {
    const received = collectIactSend();
    const { container } = await renderAssistant('需要我帮你[验证首击删除](!send)吗？');

    const chips = container.querySelectorAll<HTMLElement>('[data-iact-send]');
    expect(chips).toHaveLength(1);
    const chip = chips[0];
    expect(chip.dataset.iactSend).toBe('验证首击删除');
    // 轻链接样式标识：dotted 下划线 + 可读 accent 字；无旧 pill 的边框类
    expect(chip.className).toContain('decoration-dotted');
    expect(chip.className).toContain('text-accent-accessible');
    expect(chip.className).not.toContain('text-primary-400');
    expect(chip.className).not.toContain('border');
    // 无选项行
    expect(container.querySelector('[data-iact-options]')).toBeNull();

    fireEvent.click(chip);
    expect(received).toEqual(['验证首击删除']);
  });

  it('同段 2 个 !send：正文降级纯文本，段后出现选项行（2 按钮、首项品牌青、点击 detail 正确）', async () => {
    const received = collectIactSend();
    const { container } = await renderAssistant(
      '需要我帮你[验证首击删除](!send)，还是[测试 appshot 语义识别](!send)？',
    );

    // 正文无 chip（句子恢复干净）
    expect(container.querySelectorAll('[data-iact-send]')).toHaveLength(0);
    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe('需要我帮你验证首击删除，还是测试 appshot 语义识别？');

    // 段后选项行：2 个 ghost 按钮
    const row = container.querySelector('[data-iact-options]');
    expect(row).toBeTruthy();
    const buttons = row!.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('验证首击删除');
    expect(buttons[1].textContent).toContain('测试 appshot 语义识别');
    // 首项可读 accent；次项 zinc ghost 档
    expect(buttons[0].className).toContain('border-accent-accessible/35');
    expect(buttons[0].className).toContain('text-accent-accessible');
    expect(buttons[0].className).not.toContain('border-primary-500/35');
    expect(buttons[0].className).not.toContain('text-primary-400');
    expect(buttons[1].className).toContain('border-zinc-700');
    expect(buttons[1].className).toContain('text-zinc-300');

    fireEvent.click(buttons[1]);
    expect(received).toEqual(['测试 appshot 语义识别']);
    fireEvent.click(buttons[0]);
    expect(received).toEqual(['测试 appshot 语义识别', '验证首击删除']);
  });

  it('跨段落各 1 个 !send：各自仍是轻链接，不摘出选项行', async () => {
    const { container } = await renderAssistant('先[选项一](!send)\n\n再[选项二](!send)');

    const chips = container.querySelectorAll<HTMLElement>('[data-iact-send]');
    expect(chips).toHaveLength(2);
    expect(chips[0].dataset.iactSend).toBe('选项一');
    expect(chips[1].dataset.iactSend).toBe('选项二');
    expect(container.querySelector('[data-iact-options]')).toBeNull();
  });

  it('流式中途第二个链接未写完：只有 1 个完整 chip，不提前出选项行', async () => {
    const { container } = await renderAssistant('需要[选项一](!send)还是[选');

    expect(container.querySelectorAll('[data-iact-send]')).toHaveLength(1);
    expect(container.querySelector('[data-iact-options]')).toBeNull();
  });
});
