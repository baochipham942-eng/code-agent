// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const handlers = vi.hoisted(() => ({ show: null as null | ((e: unknown) => void) }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) handlers.show = cb;
      return () => {};
    },
  },
}));
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification: vi.fn(),
  registerNotificationClick: vi.fn(async () => undefined),
  reportNotificationHandled: vi.fn(),
}));

import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { postOsNotification } from '../../../src/renderer/utils/osNotification';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useToastStore.setState({ toasts: [] });
});

const copy = cronCenterZh.cronCenter;
const fail = (id: string, sessionId: string) =>
  ({ id, title: '任务失败 - X', body: 'b', sessionId, urgent: true, failure: true });
const needsInput = (id: string, sessionId: string, dedupeKey: string) =>
  ({ id, title: '有操作等你确认', body: '无人值守任务请求执行 write_file', sessionId, urgent: true, dedupeKey });
const retract = (dedupeKey: string) =>
  ({ id: 'r1', title: '', body: '', sessionId: '', retract: true, dedupeKey });

describe('useCronOsNotification 回到前台补提醒', () => {
  it('失焦到达，聚焦后恰好一条带「查看」的 toast，打开对应会话', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useToastStore.setState({ toasts: [] });
    useSessionStore.setState({ currentSessionId: 'other' });
    const open = vi.fn();
    renderHook(() => useCronOsNotification(copy, open));
    handlers.show!(fail('1', 'sess-1'));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    focus.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].action?.label).toBe('查看');
    toasts[0].action!.onClick();
    expect(open).toHaveBeenCalledWith('sess-1');
  });

  it('聚焦时到达：不补提醒', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useToastStore.setState({ toasts: [] });
    renderHook(() => useCronOsNotification(copy, vi.fn()));
    handlers.show!(fail('1', 'sess-1'));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('多条合并成一条，查看打开最近一条；needs-input 为 warning', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useSessionStore.setState({ currentSessionId: 'other' });
    const open = vi.fn();
    renderHook(() => useCronOsNotification(copy, open));
    handlers.show!(fail('1', 'a'));
    handlers.show!(fail('2', 'b'));
    focus.mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('2');
    toasts[0].action!.onClick();
    expect(open).toHaveBeenCalledWith('b');
  });

  it('当前会话的提醒：不弹 toast', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useSessionStore.setState({ currentSessionId: 'cur' });
    renderHook(() => useCronOsNotification(copy, vi.fn()));
    handlers.show!(fail('1', 'cur'));
    focus.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('审批裁决后的 retract 到达：被撤回的 needs-input 不再补提醒，另一条失败提醒保留', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useSessionStore.setState({ currentSessionId: 'other' });
    const open = vi.fn();
    renderHook(() => useCronOsNotification(copy, open));
    handlers.show!(needsInput('n1', 'sess-1', 'perm-1'));
    handlers.show!(fail('2', 'sess-2'));
    handlers.show!(retract('perm-1'));
    focus.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    toasts[0].action!.onClick();
    expect(open).toHaveBeenCalledWith('sess-2');
  });

  it('唯一的 needs-input 被撤回后：回来一条 toast 都不弹', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useSessionStore.setState({ currentSessionId: 'other' });
    renderHook(() => useCronOsNotification(copy, vi.fn()));
    handlers.show!(needsInput('n1', 'sess-1', 'perm-1'));
    handlers.show!(retract('perm-1'));
    focus.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('retract 事件本身不弹 OS 通知', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    renderHook(() => useCronOsNotification(copy, vi.fn()));
    vi.mocked(postOsNotification).mockClear();
    handlers.show!(retract('perm-1'));
    expect(postOsNotification).not.toHaveBeenCalled();
  });
});
