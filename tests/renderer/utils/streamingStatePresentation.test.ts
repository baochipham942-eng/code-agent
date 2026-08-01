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
    // snapshot.turnId 是 host 现铸 UUID，投影 turnId 是位置序号 turn-N —— 归属靠
    // 节点匹配：重水化回填的消息 id=snapshot.turnId，节点 messageId/id 前缀命中。
    const interruptedTurn = makeTurn({
      status: 'completed',
      nodes: [
        {
          id: 'turn-1-text',
          messageId: 'turn-1',
          type: 'assistant_text',
          content: 'partial',
          timestamp: 1_500,
        },
      ],
    });
    const snapshotted = buildStreamingUiState({
      t: zh,
      turn: interruptedTurn,
      isActiveTurn: false,
      streamSnapshot: makeSnapshot(),
    });

    expect(paused.status).toBe('resumable');
    expect(snapshotted.status).toBe('resumable');
    expect(snapshotted.showResumeHint).toBe(true);
    expect(hasIncompleteStreamSnapshot(makeSnapshot({ turnId: 'other-turn' }), interruptedTurn)).toBe(false);
    expect(hasIncompleteStreamSnapshot(makeSnapshot(), makeTurn())).toBe(false);
  });

  it('会话仍在处理中时，命中的 snapshot 不把活跃轮盖成 resumable', () => {
    const interruptedTurn = makeTurn({
      nodes: [
        {
          id: 'turn-1-text',
          messageId: 'turn-1',
          type: 'assistant_text',
          content: 'partial',
          timestamp: 1_500,
        },
      ],
    });
    const state = buildStreamingUiState({
      t: zh,
      turn: interruptedTurn,
      isActiveTurn: true,
      sessionStatus: 'running',
      isSessionProcessing: true,
      streamSnapshot: makeSnapshot(),
    });

    expect(state.status).toBe('drafting');
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
    // 停止语义：停的是这次输出，不是这个任务的记忆。cancel() 会把已写出的内容连同
    // [cancelled] 标记落库，所以文案必须说「保留」，不能再声称「未保留半截内容」。
    // 这句话现在长在 run 徽章那一行，正文在它下面——不能再说「在上面」。
    expect(state.detail).toContain('都留着');
    expect(state.detail).not.toContain('在上面');
    expect(state.detail).not.toContain('未保留');
    // 这句解释由 run 徽章那一行的阶段位承担；大黄卡收起，停止态只留一条横幅。
    expect(shouldShowStreamingState(state)).toBe(false);
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

  // 取消只持续几秒，顶部 run 徽章已经在说「正在停止 · 本轮已取消」；底下再铺一张
  // 大横幅是同一件事说两遍，动静远大于信息量（真机反馈 2026-08-01）。
  it('取消中不再单独铺一张状态横幅', () => {
    expect(shouldShowStreamingState({
      status: 'cancelling',
      label: '正在停止',
      tone: 'warning',
      shouldAnimate: true,
    } as never)).toBe(false);
  });

  // 2026-08-01 验收截图：两条都写「已取消」的横幅上下叠着。
  it('取消完成同样只留 run 徽章那一行', () => {
    expect(shouldShowStreamingState({
      status: 'cancelled',
      label: '已取消',
      tone: 'warning',
      shouldAnimate: false,
    } as never)).toBe(false);
  });
});
