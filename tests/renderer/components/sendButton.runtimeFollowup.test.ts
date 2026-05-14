import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';

describe('SendButton runtime follow-up state', () => {
  it('labels running-state submit as queued next-turn input', () => {
    const html = renderToStaticMarkup(
      React.createElement(SendButton, { isProcessing: true, hasContent: true, type: 'submit' }),
    );

    expect(html).toContain('排队到下一轮');
    expect(html).not.toContain('中断');
  });
});
