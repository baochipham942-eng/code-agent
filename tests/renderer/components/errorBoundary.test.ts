import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary } from '../../../src/renderer/components/ErrorBoundary';

describe('ErrorBoundary', () => {
  it('does not render the temporary runtime error banner in fallback UI', () => {
    const boundary = new ErrorBoundary({ children: React.createElement('div', null, 'ok') });
    boundary.state = {
      hasError: true,
      error: new Error('boom'),
      errorInfo: undefined,
    };

    const html = renderToStaticMarkup(boundary.render());

    expect(html).toContain('出错了');
    expect(html).toContain('查看错误详情');
    expect(html).not.toContain('Runtime Error');
  });
});
