import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { AssistantMessage } from '../../../src/renderer/components/features/chat/MessageBubble';

describe('AssistantMessage reasoning privacy', () => {
  it('does not render collapsed thinking content into static markup', () => {
    const message: Message = {
      id: 'assistant-thinking-1',
      role: 'assistant',
      content: 'visible answer',
      reasoning: 'private hidden thinking text',
      timestamp: 100,
    };

    const html = renderToStaticMarkup(
      React.createElement(AssistantMessage, { message }),
    );

    expect(html).toContain('thinking');
    expect(html).toContain('visible answer');
    expect(html).not.toContain('private hidden thinking text');
  });
});
