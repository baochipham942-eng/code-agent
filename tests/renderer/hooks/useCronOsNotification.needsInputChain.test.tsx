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
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';

// host notifyNeedsInput 的 payload 形状
const needsInput = { id: 'n1', title: '需要授权 - T', body: 'bash', sessionId: 's', urgent: true };

const setViewing = (id: string | null) => useSessionStore.setState({ currentSessionId: id });
const setDoc = (focus: boolean, hidden: boolean) => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focus);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
};
const deliveryReport = { mode: 'suppressed-viewing', dispatched: false };

beforeEach(() => {
  useAppStore.setState({ showSettings: false, showCronCenter: false, showCapabilityHub: false });
  setViewing('other-session');
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.spyOn(document, 'hasFocus').mockReturnValue(true); // app 聚焦且页面可见
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

describe('needs_input 聚焦链路（hook → postOsNotification）', () => {
  it('urgent 事件（看别的会话）在聚焦时仍 sendNotification 并回报 dispatched:true, urgent:true', async () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!(needsInput);
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      expect.objectContaining({ granted: true, dispatched: true, urgent: true }),
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

  it('① needs-input + 聚焦可见 + 正看该会话 → 不弹，回报 suppressed-viewing', async () => {
    setViewing('s');
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!(needsInput);
    await flush();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', deliveryReport);
  });

  it('② 空 sessionId → 视为没在看，照弹', async () => {
    setViewing('');
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!({ ...needsInput, sessionId: '' });
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['失焦', false, false],
    ['页面隐藏', true, true],
  ])('② 正看该会话但%s → 仍弹', async (_n, focus, hidden) => {
    setViewing('s');
    setDoc(focus, hidden);
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

  it('③ 失败事件即使正看该会话也照弹（行为不变）', async () => {
    setViewing('s');
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!({ ...needsInput, failure: true });
    await flush();
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('③ 非 urgent 事件正看该会话仍是 suppressed-focused', async () => {
    setViewing('s');
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!({ ...needsInput, urgent: undefined });
    await flush();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'suppressed-focused', dispatched: false },
    );
  });

  it.each(['showSettings', 'showCronCenter', 'showCapabilityHub'] as const)(
    '② 正看该会话但 %s 二级页盖住会话区 → 仍弹（审批卡不在屏幕上）',
    async (flag) => {
      setViewing('s');
      useAppStore.setState({ [flag]: true });
      renderHook(() => useCronOsNotification({} as never, () => {}));
      handlers.show!(needsInput);
      await flush();
      expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    },
  );
});

// ============================================================================
// 专注模式（N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU3-FU1）：workbench 专注态收起聊天列，
// 审批卡不在屏幕上——「正看着该会话」不成立，needs-input 横幅必须照弹。
// App.tsx 只在 !workbenchFocusActive 时渲染聊天列，且右栏不可见时会把 store 复位，
// 所以 store 值就是有效专注态；这里用真 store 驱动。
// ============================================================================
describe('needs_input × 专注模式（聊天列收起 = 没在看）', () => {
  beforeEach(() => {
    useAppStore.setState({ showSettings: false, showCronCenter: false, showCapabilityHub: false });
    setViewing('s');
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    plugin.isPermissionGranted.mockResolvedValue(true);
    plugin.onAction.mockResolvedValue({ unregister: vi.fn() });
    getNativeDesktopPermissionStatus.mockResolvedValue({
      permissions: [{ kind: 'notifications', status: 'granted' }],
    });
  });

  afterEach(() => {
    cleanup();
    useWorkbenchFocusStore.setState({ workbenchFocused: false });
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('专注模式开（聊天列收起）→ 横幅照弹，不再按「正看着该会话」抑制', async () => {
    useWorkbenchFocusStore.setState({ workbenchFocused: true });
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

  it('专注模式关 + 正看该会话 → 照旧抑制（审批卡在屏幕上）', async () => {
    useWorkbenchFocusStore.setState({ workbenchFocused: false });
    renderHook(() => useCronOsNotification({} as never, () => {}));
    handlers.show!(needsInput);
    await flush();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', deliveryReport);
  });
});
