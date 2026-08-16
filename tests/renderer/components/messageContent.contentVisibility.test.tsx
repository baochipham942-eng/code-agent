import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import {
  CONTENT_INTRINSIC_SIZE_PX,
  HEAVY_TURN_CONTENT_MIN_CHARS,
  TURN_CONTENT_INTRINSIC_SIZE_PX,
} from '../../../src/renderer/utils/turnContentVisibility';
import { renderToStaticMarkupAsync } from './renderToStaticMarkupAsync';

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

  it('defers completed code blocks with line-count intrinsic size tiers', async () => {
    const compactCode = ['```ts', ...Array.from({ length: 6 }, (_, index) => `const n${index} = ${index};`), '```'].join('\n');
    const largeCode = ['```ts', ...Array.from({ length: 40 }, (_, index) => `const n${index} = ${index};`), '```'].join('\n');

    const compactHtml = await renderToStaticMarkupAsync(
      <MessageContent content={compactCode} isUser={false} />,
    );
    const largeHtml = await renderToStaticMarkupAsync(
      <MessageContent content={largeCode} isUser={false} />,
    );
    const streamingHtml = await renderToStaticMarkupAsync(
      <MessageContent content={largeCode} isUser={false} isStreaming />,
    );

    expect(compactHtml).toContain('data-deferred-content="code-block"');
    expect(compactHtml).toContain(`contain-intrinsic-size:auto ${CONTENT_INTRINSIC_SIZE_PX.codeCompact}px`);
    expect(largeHtml).toContain(`contain-intrinsic-size:auto ${CONTENT_INTRINSIC_SIZE_PX.codeCollapsed}px`);
    expect(streamingHtml).not.toContain('data-deferred-content="code-block"');
  });
});
