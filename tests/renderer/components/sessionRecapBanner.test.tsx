// @vitest-environment jsdom
// ============================================================================
// A6 追赶横幅：触发时机 + 可关闭 + 不打扰连续使用中的会话
// ============================================================================
// 承重断言是**只在"离开后又回来"时才追赶**：进入会话会把 lastViewed 刷成现在，
// 所以人在会话里看着跑完的轮次不会被再追赶一遍。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { SessionRecapBanner } from '../../../src/renderer/components/features/chat/SessionRecapBanner';

const domainInvoke = vi.fn();
const originalDomainAPI = window.domainAPI;

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
