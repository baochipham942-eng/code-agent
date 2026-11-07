// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const h = vi.hoisted(() => ({
  show: null as null | ((e: unknown) => void),
  click: null as null | ((e: { payload: { id: string } }) => void),
  unlisten: vi.fn(),
  action: null as null | (() => void),
  parked: [] as Array<{ sessionId: string; status: string }>,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) h.show = cb;
      return () => {};
    },
    invokeDomain: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_n: string, cb: (e: { payload: { id: string } }) => void) => {
    h.click = cb;
    return h.unlisten;
  }),
}));
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: { listParkedApprovals: vi.fn(async () => h.parked) },
}));
vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification: vi.fn(async () => undefined),
  registerNotificationClick: vi.fn(async (cb: () => void) => {
    h.action = cb;
    return async () => {};
  }),
}));

import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const flush = () => new Promise((r) => setTimeout(r, 20));
const done = { id: 'a', title: 'done', body: 'ok', sessionId: 'sess-a' };
const ask = { id: 'b', title: 'ask', body: 'approve?', sessionId: 'sess-b', urgent: true };

let open: ReturnType<typeof vi.fn>;
const mount = async () => {
  open = vi.fn();
  renderHook(() => useCronOsNotification({} as never, open as never));
  await flush();
};
const click = async (id: string) => { h.click!({ payload: { id } }); await flush(); };

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  h.parked = [];
  h.click = null;
  h.unlisten.mockClear();
  useCronStore.setState({ selectedJobId: null });
  useAppStore.setState({ showCronCenter: false, cronCenterRunsRequested: false });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('notification-clicked 路由', () => {
  it('完成事件 → 打开该 run 的会话', async () => {
    await mount();
    h.show!(done);
    await click('a');
    expect(open).toHaveBeenCalledWith('sess-a');
  });

  it('needs-input 且有 pending 待审批 → 自动化中心 runs 页（中心已开在 jobs 也行）', async () => {
    h.parked = [{ sessionId: 'sess-b', status: 'pending' }];
    useAppStore.setState({ showCronCenter: true });
    await mount();
    h.show!(ask);
    await click('b');
    expect(open).not.toHaveBeenCalled();
    expect(useAppStore.getState().showCronCenter).toBe(true);
    expect(useAppStore.getState().cronCenterRunsRequested).toBe(true);
  });

  it('needs-input 无待审批项（或仅 orphaned）→ 会话', async () => {
    h.parked = [{ sessionId: 'sess-b', status: 'orphaned' }];
    await mount();
    h.show!(ask);
    await click('b');
    expect(open).toHaveBeenCalledWith('sess-b');
    expect(useAppStore.getState().cronCenterRunsRequested).toBe(false);
  });

  it('仅 jobId → 自动化中心并选中该任务', async () => {
    await mount();
    h.show!({ id: 'j', title: 't', body: 'b', jobId: 'job-9', urgent: true });
    await click('j');
    expect(open).not.toHaveBeenCalled();
    expect(useCronStore.getState().selectedJobId).toBe('job-9');
    expect(useAppStore.getState().showCronCenter).toBe(true);
  });

  it.each([
    ['完成', { id: 'jc', title: 't', body: 'b', jobId: 'job-c' }, 'job-c'],
    ['失败', { id: 'jf', title: 't', body: 'b', jobId: 'job-f', failure: true }, 'job-f'],
  ])('%s事件仅 jobId → 自动化中心并选中该任务', async (_n, ev, jobId) => {
    await mount();
    h.show!(ev);
    await click(ev.id);
    expect(open).not.toHaveBeenCalled();
    expect(useCronStore.getState().selectedJobId).toBe(jobId);
    expect(useAppStore.getState().showCronCenter).toBe(true);
  });

  it('重复事件、事件+旧 onAction 只路由一次', async () => {
    await mount();
    h.show!(done);
    await click('a');
    await click('a');
    h.action!();
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('两条待处理，点第一条 → 打开第一条', async () => {
    await mount();
    h.show!(done);
    h.show!({ id: 'c', title: 't', body: 'b', sessionId: 'sess-c' });
    await click('a');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('sess-a');
  });

  it('卸载时取消 notification-clicked 监听', async () => {
    open = vi.fn();
    const view = renderHook(() => useCronOsNotification({} as never, open as never));
    await flush();
    expect(h.unlisten).not.toHaveBeenCalled();
    view.unmount();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it('未知 id → 不导航并 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    h.show!(done);
    await click('nope');
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown notification id'), 'nope');
  });
});
