import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';

describe('CodeBlock', () => {
  it('renders long code blocks collapsed on the first render', () => {
    const code = Array.from({ length: 30 }, (_, index) => `const line_${index + 1} = ${index + 1};`).join('\n');
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: 'ts', code }),
    );

    expect(html).toContain('展开全部 (30 行)');
    expect(html).toContain('data-code-preview="plain"');
    expect(html).toContain('data-code-block-lines="30"');
    expect(html).toContain('data-code-highlighted-lines="0"');
    expect(html).toContain('data-code-highlight-complete="true"');
    expect(html).toContain('line_25');
    expect(html).not.toContain('line_26');
    expect(html).not.toContain('line_30');
  });
});
