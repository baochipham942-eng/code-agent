import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import {
  HEAVY_TURN_CONTENT_MIN_CHARS,
  TURN_CONTENT_INTRINSIC_SIZE_PX,
} from '../../../src/renderer/utils/turnContentVisibility';

describe('MessageContent content visibility', () => {
  const heavyContent = 'Long completed markdown paragraph. '.repeat(
    Math.ceil(HEAVY_TURN_CONTENT_MIN_CHARS / 35) + 1,
  );

  it('defers layout and paint for heavy completed assistant markdown', () => {
    const html = renderToStaticMarkup(
      <MessageContent content={heavyContent} isUser={false} />,
    );

    expect(html).toContain('data-turn-heavy-content="true"');
    expect(html).toContain('content-visibility:auto');
    expect(html).toContain(`contain-intrinsic-size:auto ${TURN_CONTENT_INTRINSIC_SIZE_PX}px`);
  });

  it('keeps streaming and lightweight content fully rendered for stable follow scrolling', () => {
    const streamingHtml = renderToStaticMarkup(
      <MessageContent content={heavyContent} isUser={false} isStreaming />,
    );
    const shortHtml = renderToStaticMarkup(
      <MessageContent content="Short answer" isUser={false} />,
    );

    expect(streamingHtml).not.toContain('data-turn-heavy-content');
    expect(shortHtml).not.toContain('data-turn-heavy-content');
  });
});
