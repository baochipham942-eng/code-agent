// ============================================================================
// helpers/utils.formatError：路由错误序列化边界（Error / string / circular）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { formatError } from '../../../src/web/helpers/utils';

describe('formatError', () => {
  it('returns Error.message', () => {
    expect(formatError(new Error('db down'))).toBe('db down');
  });

  it('returns string errors as-is', () => {
    expect(formatError('plain failure')).toBe('plain failure');
  });

  it('JSON.stringifies plain objects', () => {
    expect(formatError({ code: 'E_FAIL', n: 1 })).toBe('{"code":"E_FAIL","n":1}');
  });

  it('falls back to String() for circular structures that cannot be stringified', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const formatted = formatError(circular);
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
    // Must not throw; Node typically yields "[object Object]"
    expect(formatted).toContain('object');
  });

  it('stringifies null and numbers without throwing', () => {
    expect(formatError(null)).toBe('null');
    expect(formatError(42)).toBe('42');
  });
});
