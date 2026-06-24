import { describe, expect, it } from 'vitest';
import type { ManagedBrowserSessionState } from '../../../src/shared/contract/desktop';
import {
  getManagedSessionFromChangeEvent,
  getPermissionReadinessTone,
} from '../../../src/renderer/hooks/useWorkbenchBrowserSession';

describe('useWorkbenchBrowserSession readiness helpers', () => {
  it('does not mark unprobed permissions as blocked', () => {
    expect(getPermissionReadinessTone(null)).toBe('neutral');
    expect(getPermissionReadinessTone({ status: 'unknown' })).toBe('neutral');
  });

  it('marks granted permissions ready and denied permissions blocked', () => {
    expect(getPermissionReadinessTone({ status: 'granted' })).toBe('ready');
    expect(getPermissionReadinessTone({ status: 'denied' })).toBe('blocked');
    expect(getPermissionReadinessTone({ status: 'needs_restart' })).toBe('blocked');
    expect(getPermissionReadinessTone({ status: 'wrong_bundle_id' })).toBe('blocked');
    expect(getPermissionReadinessTone({ status: 'unsupported' })).toBe('blocked');
  });

  it('accepts pushed managed browser session changes without an extra poll', () => {
    const session: ManagedBrowserSessionState = {
      running: true,
      tabCount: 1,
      activeTab: {
        id: 'tab_1',
        url: 'http://127.0.0.1:8192/package.json',
        title: 'package.json',
      },
    };

    expect(getManagedSessionFromChangeEvent({
      reason: 'navigate',
      session,
    })).toEqual(session);
    expect(getManagedSessionFromChangeEvent(null)).toBeNull();
  });
});
