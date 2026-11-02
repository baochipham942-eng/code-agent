// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { CRON_FAILURE_CODE } from '../../../src/shared/utils/cronFailureClassification';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const handlers = vi.hoisted(() => ({ show: null as null | ((e: unknown) => void) }));
const postOsNotification = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel === 'notification:show' || channel === IPC_CHANNELS.NOTIFICATION_SHOW) handlers.show = cb;
      return () => {};
    },
  },
}));
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification,
  registerNotificationClick: vi.fn(async () => undefined),
}));

import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';

afterEach(() => {
  cleanup();
  postOsNotification.mockReset();
  vi.restoreAllMocks();
});

describe('useCronOsNotification urgent 转发', () => {
  it('把事件的 urgent 传给 postOsNotification，缺省为 false', () => {
    renderHook(() => useCronOsNotification({} as never, () => {}));
    expect(handlers.show).toBeTruthy();
    handlers.show!({ id: '1', title: '任务失败 - A', body: 'b', sessionId: 's', urgent: true });
    handlers.show!({ id: '2', title: '任务完成 - A', body: 'b', sessionId: 's' });
    expect(postOsNotification.mock.calls[0][1]).toMatchObject({ urgent: true });
    expect(postOsNotification.mock.calls[1][1]).toMatchObject({ urgent: false });
  });
});

describe('useCronOsNotification 前台失败 toast 动作', () => {
  it('toast 动作与原生通知点击一致：打开失败会话', async () => {
    const { postOsNotification: real } = await vi.importActual<typeof import('../../../src/renderer/utils/osNotification')>(
      '../../../src/renderer/utils/osNotification',
    );
    postOsNotification.mockImplementation(real);
    (globalThis as Record<string, unknown>).window = Object.assign(globalThis.window ?? {}, {});
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useToastStore.setState({ toasts: [] });
    const onOpenSession = vi.fn();
    renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, onOpenSession));
    handlers.show!({ id: '1', title: '[定时] A', body: 'b', sessionId: 'sess-1', urgent: true, failure: true });
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const t = useToastStore.getState().toasts[0];
    expect(t.action?.label).toBe('查看');
    t.action!.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('sess-1');
  });

  it('云端调度器不可用：toast 动作打开 Cron Center 并选中该任务', async () => {
    const { postOsNotification: real } = await vi.importActual<typeof import('../../../src/renderer/utils/osNotification')>(
      '../../../src/renderer/utils/osNotification',
    );
    postOsNotification.mockImplementation(real);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useToastStore.setState({ toasts: [] });
    useAppStore.getState().setShowCronCenter(false);
    renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, vi.fn()));
    handlers.show!({
      id: '2', title: '[定时] B', body: 'b', sessionId: '', urgent: true, failure: true,
      code: CRON_FAILURE_CODE, failureKind: 'cloud_unavailable', jobId: 'job-9',
    });
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    useToastStore.getState().toasts[0].action!.onClick();
    expect(useCronStore.getState().selectedJobId).toBe('job-9');
    expect(useAppStore.getState().showCronCenter).toBe(true);
  });

  it('连续两条失败：点 A 的 toast 打开 A 的会话，不是最近一条 B', async () => {
    const { postOsNotification: real } = await vi.importActual<typeof import('../../../src/renderer/utils/osNotification')>(
      '../../../src/renderer/utils/osNotification',
    );
    postOsNotification.mockImplementation(real);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useToastStore.setState({ toasts: [] });
    const onOpenSession = vi.fn();
    renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, onOpenSession));
    handlers.show!({ id: 'a', title: '[定时] A', body: 'b', sessionId: 'sess-A', urgent: true, failure: true });
    handlers.show!({ id: 'b', title: '[定时] B', body: 'b', sessionId: 'sess-B', urgent: true, failure: true });
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(2));
    useToastStore.getState().toasts[0].action!.onClick();
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith('sess-A');
  });

  it('urgent 但非 failure（needs-input）：不出 toast', async () => {
    const { postOsNotification: real } = await vi.importActual<typeof import('../../../src/renderer/utils/osNotification')>(
      '../../../src/renderer/utils/osNotification',
    );
    postOsNotification.mockImplementation(real);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useToastStore.setState({ toasts: [] });
    renderHook(() => useCronOsNotification(cronCenterZh.cronCenter, vi.fn()));
    handlers.show!({ id: 'n', title: '需要确认', body: 'b', sessionId: 's', urgent: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
