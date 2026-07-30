// @vitest-environment jsdom
// ============================================================================
// A6 追赶横幅：触发时机 + 可关闭 + 不打扰连续使用中的会话
// ============================================================================
// 承重断言是**只在"离开后又回来"时才追赶**：进入会话会把 lastViewed 刷成现在，
// 所以人在会话里看着跑完的轮次不会被再追赶一遍。
// ============================================================================

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { SessionRecapBanner } from '../../../src/renderer/components/features/chat/SessionRecapBanner';

const domainInvoke = vi.fn();
const originalDomainAPI = window.domainAPI;
const originalVisibilityState = document.visibilityState;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

const lastViewedKey = (sessionId: string) => `neo:recap:lastViewed:${sessionId}`;

beforeEach(() => {
  domainInvoke.mockReset();
  domainInvoke.mockResolvedValue({
    success: true,
    data: { text: '帮你把文章扩写了三段、改了图表配色，有一项因为素材缺失卡住了', degraded: false, completedCount: 2, blockedCount: 1 },
  });
  Object.defineProperty(window, 'domainAPI', {
    configurable: true,
    value: { invoke: domainInvoke },
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: originalDomainAPI });
});

describe('SessionRecapBanner', () => {
  it('第一次进这个会话不追赶（没有"上次"可比），只记时间戳', () => {
    render(<SessionRecapBanner sessionId="session-1" />);
    expect(domainInvoke).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('neo:recap:lastViewed:session-1')).toBeTruthy();
  });

  it('离开后再回来才请求追赶，并带上上次查看时间', async () => {
    window.localStorage.setItem('neo:recap:lastViewed:session-1', '1000');
    render(<SessionRecapBanner sessionId="session-1" />);

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'getRecap', {
      sessionId: 'session-1',
      since: 1000,
    });
    expect(screen.getByText(/文章扩写了三段/)).toBeTruthy();
  });

  it('可关闭', async () => {
    window.localStorage.setItem('neo:recap:lastViewed:session-1', '1000');
    render(<SessionRecapBanner sessionId="session-1" />);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());

    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('host 说没有可追赶的就不显示横幅', async () => {
    window.localStorage.setItem('neo:recap:lastViewed:session-1', '1000');
    domainInvoke.mockResolvedValue({ success: true, data: null });
    render(<SessionRecapBanner sessionId="session-1" />);

    await waitFor(() => expect(domainInvoke).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// X5.5-B4 在场水位推进：可见且聚焦期间 lastViewed 持续往前走，
// 「在场全程 → 不弹」「真离开回来 → 弹」两向都钉死。
// ----------------------------------------------------------------------------
describe('SessionRecapBanner 在场水位（X5.5-B4）', () => {
  const T0 = 1_000_000;
  const RECAP = { text: '更新了 a.txt', degraded: false, completedCount: 1, blockedCount: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setVisibility(originalVisibilityState);
  });

  it('在场全程：可见聚焦期心跳推进水位，视图重挂载不再误报', async () => {
    // host 视角：since 停在 T0（水位没推进）才有"没看过的"可讲
    domainInvoke.mockImplementation((_domain: string, _method: string, args: { since: number }) =>
      Promise.resolve({ success: true, data: args.since <= T0 ? RECAP : null }),
    );

    // 第一次进这个会话：无 since 不追赶，只记水位
    const first = render(<SessionRecapBanner sessionId="presence-1" />);
    expect(domainInvoke).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(lastViewedKey('presence-1'))).toBe(String(T0));

    // 在场 30s：心跳把水位推到现在
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(window.localStorage.getItem(lastViewedKey('presence-1'))).toBe(String(T0 + 30_000));

    // 视图重挂载（人没走）：基准是推进后的水位，host 没有新事可讲 → 不弹
    first.unmount();
    render(<SessionRecapBanner sessionId="presence-1" />);
    expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'getRecap', {
      sessionId: 'presence-1',
      since: T0 + 30_000,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('真离开回来：离开期间水位停写，空窗里的变化进追赶', async () => {
    domainInvoke.mockImplementation((_domain: string, _method: string, args: { since: number }) =>
      Promise.resolve({ success: true, data: args.since < T0 + 3_600_000 ? RECAP : null }),
    );

    const first = render(<SessionRecapBanner sessionId="away-1" />);
    expect(window.localStorage.getItem(lastViewedKey('away-1'))).toBe(String(T0));

    // 切走：hidden 当下刷一次（最后所见计入），之后心跳停写
    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(window.localStorage.getItem(lastViewedKey('away-1'))).toBe(String(T0));
    first.unmount();

    // 真离开一小时后回来：基准仍是离开时刻，空窗里的变化 → 弹
    vi.setSystemTime(T0 + 3_600_000);
    render(<SessionRecapBanner sessionId="away-1" />);
    expect(domainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'getRecap', {
      sessionId: 'away-1',
      since: T0,
    });
    // 假时钟下 testing-library 的 waitFor 轮询会被冻住，直接推一帧微任务
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/更新了 a\.txt/)).toBeTruthy();
  });
});
