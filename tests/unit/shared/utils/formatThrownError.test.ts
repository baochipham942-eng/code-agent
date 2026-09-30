import { describe, expect, it } from 'vitest';
import { formatThrownError, getProviderErrorMessage } from '../../../../src/shared/utils/providerError';

describe('formatThrownError', () => {
  it('keeps Error.message and strings as themselves', () => {
    expect(formatThrownError(new Error('boom'))).toBe('boom');
    expect(formatThrownError(new Error(''))).toBe('');
    expect(formatThrownError('boom')).toBe('boom');
    expect(formatThrownError('')).toBe('');
  });

  it('reads object message or error strings before JSON', () => {
    expect(formatThrownError({ code: 'X', message: 'boom' })).toBe('boom');
    expect(formatThrownError({ error: 'nope' })).toBe('nope');
    expect(formatThrownError({ message: 'boom', error: 'nope' })).toBe('boom');
  });

  it('JSON-stringifies a plain object that has neither field, including cycles', () => {
    expect(formatThrownError({ code: 'X', detail: 1 })).toBe('{"code":"X","detail":1}');
    const box: { code: string; self?: unknown } = { code: 'X' };
    box.self = box;
    const text = formatThrownError(box);
    expect(text).toContain('"code":"X"');
    expect(text).toContain('[Circular]');
    expect(text).not.toContain('[object Object]');
  });

  it('bounds a large JSON preview and never throws on a hostile object', () => {
    const text = formatThrownError({ detail: 'x'.repeat(3000) });
    expect(text.endsWith('...')).toBe(true);
    expect(text.length).toBeLessThan(2100);
    expect(text).not.toContain('[object Object]');

    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'message', {
      enumerable: true,
      get() {
        throw new Error('secret');
      },
    });
    expect(() => formatThrownError(hostile)).not.toThrow();
    expect(formatThrownError(hostile)).not.toContain('[object Object]');
  });

  it('does not change the empty-string contract of getProviderErrorMessage', () => {
    expect(getProviderErrorMessage({ code: 'X' })).toBe('');
    expect(formatThrownError(null)).toBe('null');
    expect(formatThrownError(undefined)).toBe('undefined');
    expect(formatThrownError(0)).toBe('0');
  });
});
