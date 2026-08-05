import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const invokeDomain = vi.fn().mockResolvedValue({ logged: true });
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args) },
}));

import { ErrorBoundary, summarizeComponentStack } from '../../../src/renderer/components/ErrorBoundary';

describe('ErrorBoundary', () => {
  beforeEach(() => {
    invokeDomain.mockReset();
    invokeDomain.mockResolvedValue({ logged: true });
  });

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

  // C1（2026-08-05）：此前渲染塌陷只上 Sentry，正式包 devtools 是关的，
  // 真机复发时本地一条日志都没有。落盘到 file logger 才有下一次定位的依据。
  it('落一份本地日志：message + stack + componentStack 摘要走 DIAGNOSTICS/logClientError', () => {
    const boundary = new ErrorBoundary({ children: React.createElement('div', null, 'ok') });
    boundary.setState = vi.fn() as never;
    const error = new TypeError('Cannot read properties of undefined (reading toLowerCase)');
    error.stack = 'TypeError: boom\n  at StreamingIndicator';

    boundary.componentDidCatch(error, {
      componentStack: '\n    at StreamingIndicator\n    at TurnCard\n    at TurnBasedTraceView',
    });

    expect(invokeDomain).toHaveBeenCalledTimes(1);
    const [domain, action, payload] = invokeDomain.mock.calls[0] as [string, string, {
      context: string;
      message: string;
      detail: string;
    }];
    expect(domain).toBe('domain:diagnostics');
    expect(action).toBe('logClientError');
    expect(payload.context).toBe('ErrorBoundary');
    expect(payload.message).toContain('TypeError');
    expect(payload.message).toContain('toLowerCase');
    expect(payload.detail).toContain('at StreamingIndicator');
    expect(payload.detail).toContain('componentStack');
  });

  it('日志通道自身失败不得再抛（否则兜底页也塌）', () => {
    invokeDomain.mockRejectedValueOnce(new Error('ipc down'));
    const boundary = new ErrorBoundary({ children: React.createElement('div', null, 'ok') });
    boundary.setState = vi.fn() as never;

    expect(() => boundary.componentDidCatch(new Error('boom'), { componentStack: null })).not.toThrow();
  });
});

describe('summarizeComponentStack', () => {
  it('只留最靠近崩溃点的前若干层，去掉空行和缩进', () => {
    const stack = ['', '    at A', '    at B', '    at C', '    at D'].join('\n');
    expect(summarizeComponentStack(stack, 2)).toBe('at A\nat B');
  });

  it('没有 componentStack 时给空串，不产出 "null"', () => {
    expect(summarizeComponentStack(null)).toBe('');
    expect(summarizeComponentStack(undefined)).toBe('');
  });
});
