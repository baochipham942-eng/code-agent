// ============================================================================
// MessageContent 轻呈现（拍板）最小断言：
// - strong 只给字重不提色（text-inherit，与所在正文同色）
// - 表格：thead 无亮底、无竖向边框、只有横向行分隔线、无斑马纹
// - 行内 code：6% 白淡底；文件引用去 chip（mono 蓝字可点，无底色块）
// ============================================================================

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

async function renderAssistant(content: string): Promise<string> {
  return renderToStaticMarkupAsync(
    <MessageContent content={content} isUser={false} messageId="assistant-1" />,
  );
}

describe('MessageContent 轻呈现', () => {
  it('strong 只给字重不提色：text-inherit，不再写死 text-zinc-200', async () => {
    const html = await renderAssistant('这是 **重点** 内容');
    expect(html).toContain('<strong class="font-semibold text-inherit">重点</strong>');
    expect(html).not.toContain('<strong class="font-semibold text-zinc-200">');
  });

  it('表格轻呈现：thead 无亮底、th 11px 灰小字、tr 只留横向分隔线、无斑马纹', async () => {
    const html = await renderAssistant('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<thead>');
    expect(html).not.toContain('<thead class="bg-zinc-800">');
    expect(html).toContain('text-[11px] font-medium text-zinc-500');
    expect(html).toContain('<tr class="border-b border-zinc-800">');
    expect(html).not.toContain('even:bg-zinc-700/20');
    expect(html).not.toContain('odd:bg-zinc-900/30');
    // 无竖向边框：th/td 不再带 border border-zinc-700
    expect(html).not.toContain('border border-zinc-700');
  });

  it('行内 code 是 6% 白淡底，不再是实心 chip 块', async () => {
    const html = await renderAssistant('执行 `npm test` 即可');
    expect(html).toContain('bg-white/[0.06]');
    expect(html).not.toContain('bg-surface-hover');
  });

  it('文件引用去 chip：mono 蓝字可点，无底色块', async () => {
    const html = await renderAssistant('改 `src/host/agent.ts:42` 这里');
    expect(html).toContain('text-primary-300');
    expect(html).toContain('cursor-pointer');
    expect(html).not.toContain('bg-surface-hover');
  });
});
