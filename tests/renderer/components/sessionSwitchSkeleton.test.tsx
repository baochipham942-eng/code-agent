// @vitest-environment jsdom
// ============================================================================
// 历史会话加载骨架屏（工单 2026-08-01）：切历史会话的空窗期被当成「空会话」。
// 三态分明——加载中（骨架屏）/ 真空会话（#874 空态）/ 冷启动未定（空白占位）；
// 150ms 内完成的快速切换不闪骨架；shimmer 尊重 prefers-reduced-motion。
// ============================================================================

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmptySessionArea,
  SESSION_SKELETON_DELAY_MS,
  SessionSwitchSkeleton,
} from '../../../src/renderer/components/features/chat/SessionSwitchSkeleton';

const WELCOME_TESTID = 'welcome-stub';

function renderArea(props: { isHydratingSession: boolean; settled: boolean }) {
  return render(
    <EmptySessionArea
      {...props}
      welcome={<div data-testid={WELCOME_TESTID}>welcome</div>}
    />,
  );
}

function mockPrefersReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('消息区空分支三态裁决（EmptySessionArea）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPrefersReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('加载中（hydration 未完）：渲染骨架屏，绝不渲染空态/欢迎页', () => {
    renderArea({ isHydratingSession: true, settled: false });
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS + 10);
    });
    expect(screen.getByTestId('session-switch-skeleton')).toBeTruthy();
    expect(screen.queryByTestId(WELCOME_TESTID)).toBeNull();
  });

  it('真空会话（hydration 完成且零消息）：渲染 #874 空态，无骨架屏', () => {
    renderArea({ isHydratingSession: false, settled: true });
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS + 10);
    });
    expect(screen.getByTestId(WELCOME_TESTID)).toBeTruthy();
    expect(screen.queryByTestId('session-switch-skeleton')).toBeNull();
  });

  it('冷启动未定会话：维持空白占位，骨架屏与空态都不出现', () => {
    const { container } = renderArea({ isHydratingSession: false, settled: false });
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS + 10);
    });
    expect(screen.queryByTestId('session-switch-skeleton')).toBeNull();
    expect(screen.queryByTestId(WELCOME_TESTID)).toBeNull();
    expect(container.querySelector('[aria-hidden]')).toBeTruthy();
  });
});

describe('骨架屏出现阈值 150ms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPrefersReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('150ms 内不上屏，过了阈值才出现', () => {
    render(<SessionSwitchSkeleton />);
    expect(screen.queryByTestId('session-switch-skeleton')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS - 10);
    });
    expect(screen.queryByTestId('session-switch-skeleton')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.getByTestId('session-switch-skeleton')).toBeTruthy();
  });

  it('快速切换（hydration 在阈值内完成）：骨架全程不出现', () => {
    const { unmount } = render(<SessionSwitchSkeleton />);
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS - 50);
    });
    unmount(); // hydration 完成，骨架卸载
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS * 2);
    });
    expect(screen.queryByTestId('session-switch-skeleton')).toBeNull();
  });
});

describe('shimmer 尊重 prefers-reduced-motion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('非 reduced-motion：占位气泡带 shimmer 扫光', () => {
    mockPrefersReducedMotion(false);
    const { container } = render(<SessionSwitchSkeleton />);
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS + 10);
    });
    expect(container.querySelectorAll('.animate-shimmer').length).toBeGreaterThan(0);
  });

  it('reduced-motion：静态占位，无 shimmer 动效', () => {
    mockPrefersReducedMotion(true);
    const { container } = render(<SessionSwitchSkeleton />);
    act(() => {
      vi.advanceTimersByTime(SESSION_SKELETON_DELAY_MS + 10);
    });
    expect(screen.getByTestId('session-switch-skeleton')).toBeTruthy();
    expect(container.querySelectorAll('.animate-shimmer').length).toBe(0);
  });
});
