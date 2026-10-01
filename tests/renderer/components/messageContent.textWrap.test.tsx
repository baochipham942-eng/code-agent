// ============================================================================
// FB-213：已完成（非流式）markdown 容器带 text-wrap:pretty，收 CJK 断行孤字；
// 流式态不带（流式期间排版还在变，pretty 每帧重排徒增成本且无收益）。
// ============================================================================

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

describe('MessageContent text-wrap:pretty', () => {
  it('已完成（非流式）markdown 容器带 [text-wrap:pretty]', async () => {
    const html = await renderToStaticMarkupAsync(
      <MessageContent content="这是 **完成态** 的正文" isUser={false} messageId="assistant-done" />,
    );
    expect(html).toContain('[text-wrap:pretty]');
  });

  it('流式态容器不带 [text-wrap:pretty]', async () => {
    const html = await renderToStaticMarkupAsync(
      <MessageContent content="这是 **流式** 的正文" isUser={false} isStreaming messageId="assistant-streaming" />,
    );
    expect(html).not.toContain('[text-wrap:pretty]');
  });
});
