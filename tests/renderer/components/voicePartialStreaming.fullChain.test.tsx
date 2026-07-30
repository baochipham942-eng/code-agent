// @vitest-environment jsdom
// ============================================================================
// X5.5 尾单复现（全链路）：projection → TurnBasedTraceView → TurnCard →
// TraceNodeRenderer。run 在跑（activeTurnIndex 指 run 轮）+ 语音临时轮在场时，
// 语音临时气泡的 assistant 字幕必须仍走 streaming 渲染分支（逐字动画）。
//
// 观测点：AssistantTextNode 走 streaming 分支时渲染 sr-only「正在生成」，
// 且 data-trace-node-id="voice-partial-assistant" 的节点在文档中。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(props: Record<string, any>, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }));
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'virtuoso-scroller' },
        props.data.map((turn: TraceTurn, index: number) => ReactModule.createElement(
          ReactModule.Fragment,
          { key: turn.turnId },
          props.itemContent(props.firstItemIndex + index, turn),
        )),
      );
    }),
  };
});

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

vi.mock('../../../src/renderer/components/PermissionDialog/PermissionCard', () => ({
  PermissionCard: () => null,
}));

import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import {
  applyVoicePartialsToProjection,
  VOICE_PARTIAL_TURN_ID,
} from '../../../src/renderer/utils/voicePartialOverlay';

afterEach(cleanup);

function runningRunMessages(): Message[] {
  return [
    { id: 'u1', role: 'user', content: '帮我建个文件', timestamp: 1_000 },
    { id: 'a1', role: 'assistant', content: '正在处理中…', timestamp: 2_000 },
  ];
}

describe('语音临时轮字幕的 streaming 分支（X5.5 尾单 · 全链路）', () => {
  it('run 在跑时，语音临时 assistant 节点仍走 streaming 渲染分支', () => {
    const base = projectTurns(runningRunMessages(), 'session-1', true);
    expect(base.activeTurnIndex).toBeGreaterThanOrEqual(0);

    const projection = applyVoicePartialsToProjection(base, {
      live: true,
      user: '再加一句口述',
      assistant: '这是通话中的临时字幕',
      startedAt: 3_000,
    });
    const voiceTurn = projection.turns.find((turn) => turn.turnId === VOICE_PARTIAL_TURN_ID);
    expect(voiceTurn?.status).toBe('streaming');

    render(<TurnBasedTraceView projection={projection} />);

    const voiceTurnEl = document.querySelector(
      `[data-trace-turn-id="${VOICE_PARTIAL_TURN_ID}"]`,
    ) as HTMLElement;
    expect(voiceTurnEl).not.toBeNull();
    // streaming 分支的可观测标记：语音临时轮内的 sr-only「正在生成」
    expect(within(voiceTurnEl).queryByText('正在生成')).not.toBeNull();
  });
});
