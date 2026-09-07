import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({
  AttachmentDisplay: () => null,
}));

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

describe('失败用户气泡呈现', () => {
  it('发送失败后保留原文，并给出失败标记和编辑重发入口', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-failed-visible',
          type: 'user',
          content: '这段需求失败后还在',
          timestamp: 1,
          metadata: { sendFailed: true },
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('data-testid="user-message-send-failed"');
    expect(html).toContain('没发出去');
    expect(html).toContain('data-testid="user-message-edit-resend"');
    expect(html).toContain('编辑重发');
    expect(html).toContain('border-red-500/40');
    expect(html).not.toContain('border-border-muted');
  });

  it('成功发出的用户气泡没有失败标记和编辑重发', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-ok',
          type: 'user',
          content: '正常发出去的',
          timestamp: 1,
        } satisfies TraceNode,
      }),
    );

    expect(html).not.toContain('data-testid="user-message-send-failed"');
    expect(html).not.toContain('编辑重发');
    expect(html).toContain('border-border-muted');
  });
});
