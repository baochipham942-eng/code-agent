// @vitest-environment jsdom
// ============================================================================
// X5.5-D4：「语音」徽标上提轮层——
// - 语音派活轮内节点级 badge 全部抑制（用户气泡 / assistant 气泡），
//   轮头（任务卡卡头 AudioLines 图标）是这通派活唯一的语音标记；
// - 非语音轮行为不变：voice 来源的用户气泡照旧显示来源小标。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

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

afterEach(cleanup);

function voiceDispatchTurn(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-voice-1',
    status: 'completed',
    startTime: 1_000,
    endTime: 3_000,
    voiceWorkOutcome: 'done',
    nodes: [
      {
        id: 'voice-dispatch-1',
        messageId: 'voice-dispatch-1',
        type: 'assistant_text',
        content: '改写后的派活指令全文',
        timestamp: 1_000,
        metadata: { voiceDispatch: { title: '建 test3.txt', workItemId: 'voice-work-1' } },
      },
      {
        // 通话回流进任务轮的语音来源文本（修前这里会再挂一个「语音」小标）
        id: 'a1-text',
        messageId: 'a1',
        type: 'assistant_text',
        content: '已创建 test3.txt。',
        timestamp: 2_000,
        metadata: { source: 'voice' },
      },
    ],
  } as TraceTurn;
}

describe('「语音」徽标上提轮层（X5.5-D4）', () => {
  it('语音派活轮内节点级 badge 全部抑制，卡头仍在（轮层只显示一次）', () => {
    render(<TurnCard turn={voiceDispatchTurn()} sessionId="session-1" defaultExpanded />);

    // 节点级「语音」小标一个都不剩
    expect(screen.queryAllByTestId('voice-source-badge')).toHaveLength(0);
    // 轮层标记在：任务卡卡头（AudioLines 图标所在）照常显示标题
    expect(screen.getByTestId('voice-task-card-header').textContent).toContain('建 test3.txt');
    // 正文内容不受抑制影响
    expect(screen.getByText('已创建 test3.txt。')).toBeTruthy();
  });

  it('非语音轮行为不变：voice 来源的用户气泡照旧显示来源小标', () => {
    const plainTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-plain',
      status: 'completed',
      startTime: 1_000,
      endTime: 2_000,
      nodes: [
        { id: 'u1', type: 'user', content: '语音说的话', timestamp: 1_000, metadata: { source: 'voice' } },
        { id: 'a1-text', messageId: 'a1', type: 'assistant_text', content: '回答', timestamp: 2_000 },
      ],
    } as TraceTurn;

    render(<TurnCard turn={plainTurn} sessionId="session-1" />);
    expect(screen.getAllByTestId('voice-source-badge').length).toBeGreaterThan(0);
  });
});
