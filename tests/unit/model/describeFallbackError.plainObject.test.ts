import { describe, expect, it } from 'vitest';
import { describeFallbackError } from '../../../src/host/model/providers/retryStrategy';

describe('describeFallbackError plain object', () => {
  it('reads message and code instead of [object Object]', () => {
    expect(describeFallbackError({ code: 'X', message: 'boom' })).toEqual({
      message: 'boom',
      code: 'X',
    });
  });

  it('uses bounded JSON when the object has no message or error string', () => {
    const described = describeFallbackError({ detail: 'socket hang up' });
    expect(described.message).toBe('{"detail":"socket hang up"}');
    expect(described.message).not.toContain('[object Object]');
    expect(described.code).toBeUndefined();
  });
});
