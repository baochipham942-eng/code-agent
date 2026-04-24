import { describe, expect, it } from 'vitest';
import { getPermissionReadinessTone } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';

describe('useWorkbenchBrowserSession readiness helpers', () => {
  it('does not mark unprobed permissions as blocked', () => {
    expect(getPermissionReadinessTone(null)).toBe('neutral');
    expect(getPermissionReadinessTone({ status: 'unknown' })).toBe('neutral');
  });

  it('marks granted permissions ready and denied permissions blocked', () => {
    expect(getPermissionReadinessTone({ status: 'granted' })).toBe('ready');
    expect(getPermissionReadinessTone({ status: 'denied' })).toBe('blocked');
    expect(getPermissionReadinessTone({ status: 'unsupported' })).toBe('blocked');
  });
});
