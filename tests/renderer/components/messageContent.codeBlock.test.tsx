// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';

const codeLines = (count: number) => Array.from(
  { length: count },
  (_, index) => `const line_${index + 1} = ${index + 1};`,
).join('\n');

describe('CodeBlock', () => {
  it('renders the same 30-line content collapsed when it is not streaming', () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: 'ts', code: codeLines(30) }),
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

  it('renders a 30-line streaming first frame expanded', () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: 'ts', code: codeLines(30), isStreaming: true }),
    );

    expect(html).toContain('data-code-block-lines="30"');
    expect(html).toContain('data-code-highlighted-lines="30"');
    expect(html).toContain('line_30');
  });

  it('stays expanded when streaming content crosses 25 lines', () => {
    const { container, rerender } = render(
      <CodeBlock language="ts" code={codeLines(25)} isStreaming />,
    );
    rerender(<CodeBlock language="ts" code={codeLines(30)} isStreaming />);

    expect(container.querySelector('[data-code-block-lines="30"]')?.getAttribute('data-code-highlighted-lines')).toBe('30');
    expect(container.textContent).toContain('line_30');
  });
});
