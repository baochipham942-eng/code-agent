import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffView } from '../../../src/renderer/components/DiffView';

function makeLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}`).join('\n');
}

describe('DiffView progressive rendering', () => {
  it('renders a bounded first chunk for very large diffs while keeping full stats', () => {
    const html = renderToStaticMarkup(
      <DiffView
        oldText={makeLines('old', 500)}
        newText={makeLines('new', 500)}
        fileName="large.ts"
      />,
    );

    expect(html).toContain('data-diff-total-rows="1002"');
    expect(html).toContain('data-diff-rendered-rows="160"');
    expect(html).toContain('data-diff-render-complete="false"');
    expect(html).toContain('+500');
    expect(html).toContain('-500');
  });

  it('renders small diffs completely on the first render', () => {
    const html = renderToStaticMarkup(
      <DiffView
        oldText={makeLines('old-small', 3)}
        newText={makeLines('new-small', 3)}
        fileName="small.ts"
      />,
    );

    expect(html).toContain('data-diff-total-rows="8"');
    expect(html).toContain('data-diff-rendered-rows="8"');
    expect(html).toContain('data-diff-render-complete="true"');
  });
});
