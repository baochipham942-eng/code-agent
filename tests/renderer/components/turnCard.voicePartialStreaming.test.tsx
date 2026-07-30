// @vitest-environment jsdom
// ============================================================================
// X5.5 尾单复现：通话中派了活（run 在跑，activeTurnIndex 指向 run 轮）时，
// 语音临时轮（VOICE_PARTIAL_TURN_ID）的 assistant 字幕也必须走 streaming
// 渲染分支（逐字动画），不能因为拿不到 active 轮身份就整块出。
//
// 观测点：AssistantTextNode 走 streaming 分支时会渲染 sr-only 的「正在生成」
// （TraceNodeRenderer.tsx 中 turnStreaming || isAnimating 的门）。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
import {
  applyVoicePartialsToProjection,
  VOICE_PARTIAL_TURN_ID,
} from '../../../src/renderer/utils/voicePartialOverlay';

afterEach(cleanup);

/** run 在跑：一条用户消息 + 一条还没写完的 assistant 回复，isProcessing=true */
function runningRunMessages(): Message[] {
  return [
    { id: 'u1', role: 'user', content: '帮我建个文件', timestamp: 1_000 },
    { id: 'a1', role: 'assistant', content: '正在处理中…', timestamp: 2_000 },
  ];
}

function voicePartialOverlayInput() {
  return {
    live: true,
    user: '再加一句口述',
    assistant: '这是通话中的临时字幕',
    startedAt: 3_000,
  };
}

describe('语音临时轮字幕的 streaming 分支（X5.5 尾单）', () => {
  it('run 在跑（active 轮是 run 轮）时，语音临时 assistant 节点仍走 streaming 渲染分支', () => {
    const base = projectTurns(runningRunMessages(), 'session-1', true);
    // 坐实前提：active 轮是 run 的轮，不是语音临时轮
    expect(base.activeTurnIndex).toBeGreaterThanOrEqual(0);

    const projection = applyVoicePartialsToProjection(base, voicePartialOverlayInput());
    const voiceTurnIndex = projection.turns.findIndex((turn) => turn.turnId === VOICE_PARTIAL_TURN_ID);
    expect(voiceTurnIndex).toBeGreaterThanOrEqual(0);
    expect(projection.turns[voiceTurnIndex].status).toBe('streaming');
    // 让位逻辑（不许动）：run 在跑时 activeTurnIndex 仍指 run 轮
    expect(projection.activeTurnIndex).not.toBe(voiceTurnIndex);

    // 与 TurnBasedTraceView itemContent 同款：isActiveTurn = index === activeTurnIndex
    render(
      <TurnCard
        turn={projection.turns[voiceTurnIndex]}
        sessionId="session-1"
        isActiveTurn={voiceTurnIndex === projection.activeTurnIndex}
      />,
    );

    // streaming 分支的可观测标记：sr-only「正在生成」
    expect(screen.queryByText('正在生成')).not.toBeNull();
  });

  it('纯聊天通话（无 run，active 轮让给语音临时轮）时同样走 streaming 分支', () => {
    const base = projectTurns(
      [{ id: 'u0', role: 'user', content: '早', timestamp: 500 } as Message],
      'session-1',
      false,
    );
    expect(base.activeTurnIndex).toBe(-1);

    const projection = applyVoicePartialsToProjection(base, voicePartialOverlayInput());
    const voiceTurnIndex = projection.turns.findIndex((turn) => turn.turnId === VOICE_PARTIAL_TURN_ID);
    expect(projection.activeTurnIndex).toBe(voiceTurnIndex);

    render(
      <TurnCard
        turn={projection.turns[voiceTurnIndex]}
        sessionId="session-1"
        isActiveTurn={voiceTurnIndex === projection.activeTurnIndex}
      />,
    );

    expect(screen.queryByText('正在生成')).not.toBeNull();
  });
});
