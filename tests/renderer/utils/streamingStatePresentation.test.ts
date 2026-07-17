import { describe, expect, it } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import type { StreamRecoverySnapshot } from '../../../src/shared/contract/session';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import {
  buildStreamingUiState,
  hasCancelledRunMarker,
  hasIncompleteStreamSnapshot,
  shouldShowStreamingState,
} from '../../../src/renderer/utils/streamingStatePresentation';

function makeTurn(overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    nodes: [],
    status: 'streaming',
    startTime: 1_000,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<StreamRecoverySnapshot> = {}): StreamRecoverySnapshot {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    content: 'partial',
    reasoning: '',
    toolCalls: [],
    estimatedTokens: 12,
    timestamp: 2_000,
    isFinal: false,
    streamStatus: 'incomplete',
    stableForExecution: false,
    incompleteToolCallIds: [],
    ...overrides,
  };
}

describe('streamingStatePresentation', () => {
  it('shows drafting for the active streaming turn', () => {
    const state = buildStreamingUiState({
      t: zh,
      turn: makeTurn(),
      isActiveTurn: true,
      sessionStatus: 'running',
      isSessionProcessing: true,
    });

    expect(state.status).toBe('drafting');
    expect(state.shouldAnimate).toBe(true);
    expect(shouldShowStreamingState(state)).toBe(false);
  });

  it('separates active tool execution from long tool waiting', () => {
    const turn = makeTurn({
      nodes: [
        {
          id: 'tool-1',
          type: 'tool_call',
          content: '',
          timestamp: 5_000,
          toolCall: { id: 'tool-1', name: 'bash', args: {} },
        },
      ],
    });

    const usingTools = buildStreamingUiState({
      t: zh,
      turn,
      isActiveTurn: true,
      sessionStatus: 'running',
      runningToolStartTime: 5_000,
      now: 10_000,
    });
    expect(usingTools.status).toBe('using_tools');
    expect(shouldShowStreamingState(usingTools)).toBe(false);

    const waitingTool = buildStreamingUiState({
      t: zh,
      turn,
      isActiveTurn: true,
      sessionStatus: 'running',
      runningToolStartTime: 5_000,
      now: 30_000,
    });
    expect(waitingTool.status).toBe('waiting_tool');
    expect(shouldShowStreamingState(waitingTool)).toBe(false);
  });

  it('prioritizes cancelling cleanup over active streaming', () => {
    const state = buildStreamingUiState({
      t: zh,
      turn: makeTurn(),
      isActiveTurn: true,
      sessionStatus: 'cancelling',
      isSessionProcessing: true,
    });

    expect(state.status).toBe('cancelling');
    expect(state.showCancelCleanup).toBe(true);
  });

  it('marks paused and incomplete snapshots as resumable', () => {
    const paused = buildStreamingUiState({
      t: zh,
      turn: makeTurn({ status: 'completed' }),
      isActiveTurn: false,
      sessionStatus: 'paused',
    });
    const snapshotted = buildStreamingUiState({
      t: zh,
      turn: makeTurn({ status: 'completed' }),
      isActiveTurn: false,
      streamSnapshot: makeSnapshot(),
    });

    expect(paused.status).toBe('resumable');
    expect(snapshotted.status).toBe('resumable');
    expect(snapshotted.showResumeHint).toBe(true);
    expect(hasIncompleteStreamSnapshot(makeSnapshot({ turnId: 'other-turn' }), 'turn-1')).toBe(false);
  });

  it('does not show completed states as streaming banners', () => {
    const state = buildStreamingUiState({
      t: zh,
      turn: makeTurn({ status: 'completed' }),
      isActiveTurn: false,
      sessionStatus: 'idle',
    });

    expect(state.status).toBe('completed');
    expect(shouldShowStreamingState(state)).toBe(false);
  });

  it('keeps cancelled turns visible after runtime cleanup', () => {
    const turn = makeTurn({
      status: 'completed',
      nodes: [
        {
          id: 'user-1',
          type: 'user',
          content: 'cancel this run',
          timestamp: 1_000,
          metadata: {
            workbench: {
              runCancellation: {
                status: 'cancelled',
                cancelledAt: 2_000,
              },
            },
          },
        },
      ],
    });
    const state = buildStreamingUiState({
      t: zh,
      turn,
      isActiveTurn: false,
      sessionStatus: 'idle',
    });

    expect(hasCancelledRunMarker(turn)).toBe(true);
    expect(state.status).toBe('cancelled');
    expect(state.detail).toContain('未保留半截内容');
    expect(shouldShowStreamingState(state)).toBe(true);
  });

  // detail 长句此前跟 label 同一批硬编码中文，但只有 label 迁了键——en 用户会看到
  // 英文 label + 中文 detail 混排。补上 en 态验证 detail 也走 turnRun.detail.* 键。
  it('detail 跟 label 走同一套 t，不会出现 en label + zh detail 混排', () => {
    const turn = makeTurn({
      status: 'completed',
      nodes: [
        {
          id: 'user-1',
          type: 'user',
          content: 'cancel this run',
          timestamp: 1_000,
          metadata: {
            workbench: {
              runCancellation: {
                status: 'cancelled',
                cancelledAt: 2_000,
              },
            },
          },
        },
      ],
    });
    const state = buildStreamingUiState({
      t: en,
      turn,
      isActiveTurn: false,
      sessionStatus: 'idle',
    });

    expect(state.label).toBe(en.turnRun.status.cancelled);
    expect(state.detail).toBe(en.turnRun.detail.cancelled);
    expect(state.detail).not.toMatch(/[一-鿿]/);
  });

  it('surfaces stale processing without replaying an old stream', () => {
    const state = buildStreamingUiState({
      t: zh,
      turn: makeTurn({ startTime: 1_000 }),
      isActiveTurn: false,
      isSessionProcessing: true,
      now: 130_000,
    });

    expect(state.status).toBe('stale');
    expect(state.shouldAnimate).toBe(false);
  });
});
