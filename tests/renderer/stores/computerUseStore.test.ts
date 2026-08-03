import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPUTER_USE_SNAPSHOT_TTL_MS,
  consumeComputerUseSystemSettingsRefresh,
  getComputerUseSnapshot,
  invalidateComputerUseSnapshot,
  invalidateComputerUseSnapshotForSystemSettings,
  isComputerUseSnapshotStale,
  isComputerUseSystemSettingsRefreshPending,
  patchComputerUseSnapshot,
  setComputerUseSnapshot,
  subscribeComputerUseSnapshot,
  type ComputerUseSnapshot,
} from '../../../src/renderer/stores/computerUseStore';

function snapshot(capturedAtMs = 10_000): ComputerUseSnapshot {
  return {
    capturedAtMs,
    nativeAvailable: true,
    capabilities: null,
    permissionSnapshot: null,
    collectorStatus: null,
    frontmost: {
      platform: 'macos',
      capturedAtMs,
      appName: 'Terminal',
    },
    recentEvents: [],
    surface: {
      id: 'surface-1',
      mode: 'background_ax',
      platform: 'macos',
      ready: true,
      background: true,
      approvedApps: ['Terminal'],
      deniedApps: [],
    },
    observation: null,
    desktopProviderError: null,
    observeError: null,
  };
}

describe('computerUseStore', () => {
  beforeEach(() => {
    setComputerUseSnapshot(null);
    consumeComputerUseSystemSettingsRefresh();
  });

  it('keeps the stale snapshot available while TTL decides whether to refresh', () => {
    const current = snapshot();
    setComputerUseSnapshot(current);

    expect(isComputerUseSnapshotStale(getComputerUseSnapshot(), current.capturedAtMs + COMPUTER_USE_SNAPSHOT_TTL_MS - 1)).toBe(false);
    expect(isComputerUseSnapshotStale(getComputerUseSnapshot(), current.capturedAtMs + COMPUTER_USE_SNAPSHOT_TTL_MS)).toBe(true);

    invalidateComputerUseSnapshot();

    expect(getComputerUseSnapshot()?.surface?.targetApp).toBeUndefined();
    expect(getComputerUseSnapshot()?.surface?.id).toBe('surface-1');
    expect(getComputerUseSnapshot()?.capturedAtMs).toBe(0);
  });

  it('patches AX state without dropping the cached permissions/frontmost snapshot', () => {
    setComputerUseSnapshot(snapshot());

    patchComputerUseSnapshot({
      surface: { ...getComputerUseSnapshot()!.surface!, targetApp: 'Safari' },
    });

    expect(getComputerUseSnapshot()).toMatchObject({
      frontmost: { appName: 'Terminal' },
      surface: { id: 'surface-1', targetApp: 'Safari' },
    });
  });

  it('marks system-settings return separately so a mounted page waits for focus', () => {
    setComputerUseSnapshot(snapshot());
    invalidateComputerUseSnapshotForSystemSettings();

    expect(isComputerUseSystemSettingsRefreshPending()).toBe(true);
    expect(getComputerUseSnapshot()?.surface?.id).toBe('surface-1');
    expect(consumeComputerUseSystemSettingsRefresh()).toBe(true);
    expect(isComputerUseSystemSettingsRefreshPending()).toBe(false);
  });

  it('notifies subscribers when stale data is invalidated', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeComputerUseSnapshot(listener);
    setComputerUseSnapshot(snapshot());
    invalidateComputerUseSnapshot();
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
