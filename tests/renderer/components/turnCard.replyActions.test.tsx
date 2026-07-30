// @vitest-environment jsdom
// ============================================================================
// X5.5-D3 / D2 动作条门：
// - D3：被切完成的轮轮尾恰挂 tool_call 时，没有 eligible 节点 → fork 与 feedback
//   一起隐（修前 feedback 锚隐、fork 锚显，动作条只剩一个 fork 图标）；
// - D2 顺手收：startTask fire-and-forget 的瞬态窗里，通话进行中的任务轮
//   不渲染动作条；挂断（phase 回 idle）后恢复常驻。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
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
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

afterEach(() => {
  cleanup();
  useVoiceCallStore.setState({ phase: 'idle' });
});

describe('TurnCard 回复动作条锚点对齐（X5.5-D3）', () => {
  it('completed 轮轮尾恰挂 tool_call：没有 eligible 节点，fork 不单独挂出', () => {
    // 真实投影：assistant 正文之后跟一条工具调用 → markFeedbackEligibleNodes
    // 把 eligible 清空（工具节点重置），fork/feedback 应当一起没有锚点。
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '帮我搜一下', timestamp: 1_000 },
      {
        id: 'a1',
        role: 'assistant',
        content: '我去搜',
        timestamp: 2_000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'Grep',
            arguments: { pattern: 'x' },
            result: { toolCallId: 'tc-1', success: true, output: 'done' },
          },
        ],
      },
    ];
    const projection = projectTurns(messages, 'session-1', false);
    const turn = projection.turns[0];
    expect(turn.status).toBe('completed');
    // 坐实前提：轮尾是工具调用，投影没有给出 eligible 节点
    expect(turn.nodes[turn.nodes.length - 1].type).toBe('tool_call');
    expect(turn.nodes.some((node) => node.feedbackEligible)).toBe(false);

    render(<TurnCard turn={turn} sessionId="session-1" />);
    expect(screen.queryByTestId('turn-reply-actions')).toBeNull();
    expect(screen.queryByTestId('turn-fork-action')).toBeNull();
  });

  it('completed 轮轮尾是正文：fork 与 feedback 共用同一个 eligible 锚点，一起出现', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1_000 },
      { id: 'a1', role: 'assistant', content: '你好，有什么可以帮你', timestamp: 2_000 },
    ];
    const projection = projectTurns(messages, 'session-1', false);
    render(<TurnCard turn={projection.turns[0]} sessionId="session-1" />);
    expect(screen.getByTestId('turn-fork-action')).toBeTruthy();
    expect(screen.getByTestId('turn-reply-actions')).toBeTruthy();
  });
});

describe('TurnCard 语音任务轮动作条瞬态窗（X5.5-D2 顺手收）', () => {
  function voiceTaskTurn(overrides: Partial<TraceTurn> = {}): TraceTurn {
    return {
      turnNumber: 1,
      turnId: 'turn-voice-1',
      status: 'completed',
      startTime: 1_000,
      endTime: 2_000,
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
          id: 'a1-text',
          messageId: 'a1',
          type: 'assistant_text',
          content: '已创建 test3.txt。',
          timestamp: 2_000,
          feedbackEligible: true,
        },
      ],
      ...overrides,
    } as TraceTurn;
  }

  it('通话进行中（live）且无结局印章 → 不渲染动作条（瞬态窗不闪）', () => {
    useVoiceCallStore.setState({ phase: 'live' });
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);
    expect(screen.queryByTestId('turn-reply-actions')).toBeNull();
  });

  it('通话进行中但结局印章已落 → 动作条照常', () => {
    useVoiceCallStore.setState({ phase: 'live' });
    render(<TurnCard turn={voiceTaskTurn({ voiceWorkOutcome: 'done' })} sessionId="session-1" />);
    expect(screen.getByTestId('turn-reply-actions')).toBeTruthy();
  });

  it('挂断后（idle）动作条恢复常驻', () => {
    useVoiceCallStore.setState({ phase: 'idle' });
    render(<TurnCard turn={voiceTaskTurn()} sessionId="session-1" />);
    expect(screen.getByTestId('turn-reply-actions')).toBeTruthy();
  });
});
