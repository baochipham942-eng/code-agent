// @vitest-environment jsdom
// ============================================================================
// N-CTXPANEL 三轮反馈（爸 2026-08-21）：压缩摘要不再以整条横幅插在消息流里，
// 降级为操作行（复制/点赞/点踩/分叉那行）最右侧的一枚象征性标记，点开可读摘要原文。
// 反向变异承重：摘掉操作行里的压缩标记（turn-compaction-marker），用例 1/2 必须红。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';

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
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

afterEach(cleanup);

const SUMMARY_TEXT = '[Context Handoff] 压缩前的摘要正文：上一轮在改上下文分桶面板。';

function messagesWithCompaction(): Message[] {
  return [
    { id: 'u1', role: 'user', content: '帮我看看上下文用量', timestamp: 1_000 },
    { id: 'a1', role: 'assistant', content: '好，我看一下。', timestamp: 2_000 },
    {
      id: 'sum1',
      role: 'system',
      content: SUMMARY_TEXT,
      timestamp: 3_000,
      compaction: {
        type: 'compaction',
        content: SUMMARY_TEXT,
        timestamp: 3_000,
        compactedMessageCount: 12,
        compactedTokenCount: 4200,
      },
    },
    { id: 'u2', role: 'user', content: '继续', timestamp: 4_000 },
    { id: 'a2', role: 'assistant', content: '继续干。', timestamp: 5_000 },
  ];
}

describe('TurnCard 压缩标记（操作行右端，横幅退役）', () => {
  it('压缩节点不再渲染整条横幅，标记挂在操作行最右端', () => {
    const projection = projectTurns(messagesWithCompaction(), 'session-1', false);
    // 坐实前提：压缩节点挂在压缩前那一轮的末尾
    expect(projection.turns[0].nodes.some((n) => n.subtype === 'compaction')).toBe(true);

    render(<TurnCard turn={projection.turns[0]} sessionId="session-1" />);

    // 旧横幅文案不再出现（操作行标记的 aria/title 除外——那是新形态）
    expect(screen.queryByText('上下文已压缩')).toBeNull();

    const actionsRow = screen.getByTestId('turn-reply-actions');
    const marker = screen.getByTestId('turn-compaction-marker');
    expect(actionsRow.contains(marker)).toBe(true);
    // 最右端：标记是操作行最后一个子元素
    expect(actionsRow.lastElementChild).toBe(marker);
  });

  it('点标记展开摘要原文，再点收起', () => {
    const projection = projectTurns(messagesWithCompaction(), 'session-1', false);
    render(<TurnCard turn={projection.turns[0]} sessionId="session-1" />);

    expect(screen.queryByTestId('turn-compaction-summary')).toBeNull();
    fireEvent.click(screen.getByTestId('turn-compaction-marker'));
    expect(screen.getByTestId('turn-compaction-summary').textContent).toContain('压缩前的摘要正文');
    fireEvent.click(screen.getByTestId('turn-compaction-marker'));
    expect(screen.queryByTestId('turn-compaction-summary')).toBeNull();
  });

  it('压缩点之后的新一轮不带标记', () => {
    const projection = projectTurns(messagesWithCompaction(), 'session-1', false);
    expect(projection.turns.length).toBe(2);
    render(<TurnCard turn={projection.turns[1]} sessionId="session-1" />);
    expect(screen.queryByTestId('turn-compaction-marker')).toBeNull();
  });
});
