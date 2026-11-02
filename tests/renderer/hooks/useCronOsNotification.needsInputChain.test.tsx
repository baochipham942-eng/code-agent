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

vi.mock('@tauri-apps/plugin-notification', () => plugin);
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

// host notifyNeedsInput 的 payload 形状
const needsInput = { id: 'n1', title: '需要授权 - T', body: 'bash', sessionId: 's', urgent: true };

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.spyOn(document, 'hasFocus').mockReturnValue(true); // app 聚焦且页面可见
  plugin.isPermissionGranted.mockResolvedValue(true);
  plugin.onAction.mockResolvedValue({ unregister: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('needs_input 聚焦链路（hook → postOsNotification）', () => {
  it('urgent 事件在聚焦时仍 sendNotification 并回报 dispatched:true, urgent:true', async () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!(needsInput);
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      expect.objectContaining({ dispatched: true, urgent: true }),
    );
  });

  it('同样聚焦下非 urgent 事件仍被抑制', async () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!({ ...needsInput, urgent: undefined, title: '任务完成 - T' });
    await flush();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'suppressed-focused', dispatched: false },
    );
  });
});
