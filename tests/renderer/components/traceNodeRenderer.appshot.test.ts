import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => content,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index', () => ({
  ToolCallDisplay: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({
  AttachmentDisplay: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ExpandableContent', () => ({
  ExpandableContent: () => null,
}));

import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

describe('TraceNodeRenderer appshot display', () => {
  it('hides appshot XML context from user prompt bubbles', () => {
    const html = renderToStaticMarkup(
      React.createElement(TraceNodeRenderer, {
        node: {
          id: 'user-hidden-context-1',
          type: 'user',
          content: `<appshot app="com.apple.finder" name="Finder">
# Appshot of Finder

CONFIDENTIAL_APPSHOT_WINDOW_TEXT
</appshot>

用一句话说明我刚截的窗口是什么`,
          timestamp: 100,
        } satisfies TraceNode,
      }),
    );

    expect(html).toContain('用一句话说明我刚截的窗口是什么');
    expect(html).not.toContain('<appshot');
    expect(html).not.toContain('&lt;appshot');
    expect(html).not.toContain('CONFIDENTIAL_APPSHOT_WINDOW_TEXT');
  });
});
