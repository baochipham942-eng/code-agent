import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../../../src/renderer/components/features/chat/MessageBubble';

describe('MessageBubble tool isolation', () => {
  it('does not render tool JSON as assistant-visible markdown', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          id: 'tool-message',
          role: 'tool',
          content: JSON.stringify([{ toolCallId: 'tool-1', output: 'raw tool payload' }]),
          timestamp: 100,
        }}
      />,
    );

    expect(html).toBe('');
    expect(html).not.toContain('raw tool payload');
  });
});
