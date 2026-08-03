// @vitest-environment jsdom
// ============================================================================
// 工单 2026-08-01（流式渲染自然化）验收组③：prefers-reduced-motion 下全部直落
// 零动画——displayContent 立即等于 content、isAnimating 恒 false、无淡入尾段。
// ============================================================================
import React from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSmoothStreamingText } from '../../../src/renderer/hooks/useSmoothStreamingText';

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

afterEach(() => {
  cleanup();
});

describe('useSmoothStreamingText prefers-reduced-motion', () => {
  it('reduced-motion：流式大块到达立即全量直落，无动画无尾段', () => {
    mockPrefersReducedMotion(true);
    const longContent = '这是一段很长的流式内容，模拟大块吐字模型的输出。'.repeat(30);

    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStreamingText({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: true } },
    );

    rerender({ content: longContent, isStreaming: true });
    expect(result.current.displayContent).toBe(longContent);
    expect(result.current.isAnimating).toBe(false);
    expect(result.current.tailStartIndex).toBeNull();

    rerender({ content: longContent, isStreaming: false });
    expect(result.current.displayContent).toBe(longContent);
    expect(result.current.isAnimating).toBe(false);
  });

  it('非 reduced-motion：大块到达先直落到阈值窗口，不立即全量', () => {
    mockPrefersReducedMotion(false);
    const longContent = 'a'.repeat(1000);

    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStreamingText({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: true } },
    );

    rerender({ content: longContent, isStreaming: true });
    expect(result.current.isAnimating).toBe(true);
    // 首帧尚未播放：显示内容仍是初始值或直落后的窗口，绝不会一步到位
    expect(result.current.displayContent.length).toBeLessThan(longContent.length);
  });
});
