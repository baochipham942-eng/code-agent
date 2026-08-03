// @vitest-environment jsdom
// ============================================================================
// 排查报告 §2 序列③④：点赞/复制/分叉动作行此前按 node.content 原始全量非空挂载，
// 与正文实际显示的打字机 displayContent（useSmoothStreamingText 的 isAnimating）
// 各走各的——turn 一 completed 按钮立刻出现，正文却还在 flush 追帧。
// 这里直接 mock useSmoothStreamingText，用它已经暴露的 isAnimating 信号驱动断言，
// 不依赖真实 requestAnimationFrame 时序。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

let mockIsAnimating = false;

vi.mock('../../../src/renderer/hooks/useSmoothStreamingText', () => ({
  useSmoothStreamingText: ({ content }: { content: string; isStreaming?: boolean }) => ({
    displayContent: mockIsAnimating ? content.slice(0, Math.max(0, content.length - 1)) : content,
    isAnimating: mockIsAnimating,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = { currentSessionId: 'session-1', sessions: [], messages: [], runningSessionIds: new Set<string>() };
  const useSessionStore = (selector?: (value: typeof state) => unknown) => (
    selector ? selector(state) : state
  );
  useSessionStore.getState = () => state;
  return { useSessionStore };
});

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createForkFromReply: vi.fn(),
    sendPrompt: vi.fn(),
  }),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  mockIsAnimating = false;
});

function completedTurnWithFinalText(content: string): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 1_000,
    endTime: 2_000,
    nodes: [
      { id: 'u1', type: 'user', content: '1', timestamp: 1_000 },
      {
        id: 'a1-text',
        messageId: 'a1',
        type: 'assistant_text',
        content,
        timestamp: 1_500,
        feedbackEligible: true,
      },
    ],
  } as TraceTurn;
}

describe('TurnCard 动作行等打字机追平（排查报告 §2 序列③④）', () => {
  it('打字机仍在追帧（isAnimating=true）：动作行不挂载', () => {
    mockIsAnimating = true;
    render(<TurnCard turn={completedTurnWithFinalText('需要我做什么？')} sessionId="session-1" />);
    expect(screen.queryByTestId('turn-reply-actions')).toBeNull();
  });

  it('打字机从追帧到追平：动作行随之从不挂载变为挂载', () => {
    mockIsAnimating = true;
    const { rerender } = render(
      <TurnCard turn={completedTurnWithFinalText('需要我做什么？')} sessionId="session-1" />,
    );
    expect(screen.queryByTestId('turn-reply-actions')).toBeNull();

    mockIsAnimating = false;
    rerender(<TurnCard turn={completedTurnWithFinalText('需要我做什么？')} sessionId="session-1" />);
    expect(screen.getByTestId('turn-reply-actions')).toBeTruthy();
  });
});
