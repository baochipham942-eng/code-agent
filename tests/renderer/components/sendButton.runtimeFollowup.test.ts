import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';

describe('SendButton runtime follow-up state', () => {
  it('labels running-state submit as foreground conversation input', () => {
    const html = renderToStaticMarkup(
      React.createElement(SendButton, { isProcessing: true, hasContent: true, type: 'submit' }),
    );

    expect(html).toContain('发送消息');
    expect(html).not.toContain('中断');
  });

  it('shows Continue for a parked durable run and yields to a draft', () => {
    const parked = renderToStaticMarkup(
      React.createElement(SendButton, {
        hasContinuation: true,
        hasContent: false,
        type: 'submit',
      }),
    );
    expect(parked).toContain('继续');
    expect(parked).toContain('continue-run-button');

    const draft = renderToStaticMarkup(
      React.createElement(SendButton, {
        hasContinuation: true,
        hasContent: true,
        type: 'submit',
      }),
    );
    expect(draft).toContain('发送消息');
    expect(draft).not.toContain('continue-run-button');
  });
});
