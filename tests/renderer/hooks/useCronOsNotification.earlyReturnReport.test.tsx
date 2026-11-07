// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';

const handlers = vi.hoisted(() => ({ show: null as null | ((e: unknown) => void) }));
const invokeDomain = vi.hoisted(() => vi.fn());
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}));
const getNativeDesktopPermissionStatus = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-notification', () => plugin);
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getNativeDesktopPermissionStatus,
  isNativeDesktopAvailable: () => true,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) handlers.show = cb;
      return () => {};
    },
    invokeDomain,
  },
}));

import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  plugin.isPermissionGranted.mockResolvedValue(true);
  plugin.onAction.mockResolvedValue({ unregister: vi.fn() });
  getNativeDesktopPermissionStatus.mockResolvedValue({
    permissions: [{ kind: 'notifications', status: 'granted' }],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const flush = () => new Promise((r) => setTimeout(r, 20));
const reports = () => invokeDomain.mock.calls.filter((c) => c[1] === 'reportClientDelivery');

describe('hook 早退分支的送达回报', () => {
  it('retract：恰好一条 reason=retract 的回报，且不弹通知', async () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!({ id: 'r1', title: '', body: '', sessionId: 's', retract: true, dedupeKey: 'k1' });
    await flush();
    expect(reports()).toHaveLength(1);
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', {
      mode: 'renderer-early-return', reason: 'retract', dispatched: false, dedupeKey: 'k1',
    });
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it('attentionOnly：恰好一条 reason=attention-only 的回报，且不弹通知', async () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!({ id: 'a1', title: '', body: '', sessionId: 's', markSessionUnread: true, attentionOnly: true });
    await flush();
    expect(reports()).toHaveLength(1);
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', {
      mode: 'renderer-early-return', reason: 'attention-only', dispatched: false,
    });
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});
