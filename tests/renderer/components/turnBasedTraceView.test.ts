// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceProjection, TraceTurn } from '../../../src/shared/contract/trace';
import {
  ACTIVE_DISPLAY_SCROLL_INTERVAL_MS,
  USER_SCROLL_PROGRAMMATIC_PAUSE_MS,
  USER_SCROLL_FOLLOW_REENGAGE_PAUSE_MS,
  getActiveDisplayScrollDelay,
  getActiveAssistantTextAnchor,
  getFocusedTurnIndex,
  getOutputFollowTurnIndex,
  getTurnOutputRevision,
  getTraceNodeSelector,
  getTraceTurnSelector,
  getUserScrollSuppressionUntil,
  isProgrammaticScrollSuppressed,
  isScrollerNearBottom,
  shouldStopFollowingForKeyboardScroll,
  shouldStopFollowingForTouchMove,
  shouldStopFollowingForWheel,
  shouldFollowTurnOutput,
  shouldShowTurnTimeSeparator,
  getPrependedTurnCount,
  getPrependAnchorScrollLocation,
  getPrependAnchorScrollCorrection,
  TurnBasedTraceView,
} from '../../../src/renderer/components/features/chat/TurnBasedTraceView';

const mocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  virtuosoProps: {} as Record<string, any>,
}));

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(props: Record<string, any>, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: mocks.scrollToIndex }));
      // 真实 Virtuoso 每渲染都把全量 props 发布进自己的 store，所以这里记下最后一次
      // 收到的 props，测试才能断言"没变的东西不许换引用"。
      mocks.virtuosoProps = props;
      const setScrollerRef = ReactModule.useCallback((element: HTMLDivElement | null) => {
        props.scrollerRef?.(element);
      }, [props.scrollerRef]);
      return ReactModule.createElement(
        'div',
        { ref: setScrollerRef, 'data-testid': 'virtuoso-scroller' },
        props.data.map((turn: TraceTurn, index: number) => ReactModule.createElement(
          ReactModule.Fragment,
          { key: turn.turnId },
          props.itemContent(props.firstItemIndex + index, turn),
        )),
      );
    }),
  };
});

vi.mock('../../../src/renderer/components/features/chat/TurnCard', () => ({
  TurnCard: () => null,
}));

vi.mock('../../../src/renderer/components/PermissionDialog/PermissionCard', () => ({
  PermissionCard: () => null,
}));

let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrameId: number;

function flushAnimationFrames(): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.scrollToIndex.mockReset();
  animationFrames = new Map();
  nextAnimationFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    animationFrames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeTurn(index: number): TraceTurn {
  return {
    turnNumber: index + 1,
    turnId: `turn-${index + 1}`,
    nodes: [],
    status: 'completed',
    startTime: 100 + index,
  };
}

function makeProjection(activeTurnIndex: number, turnCount = 3): TraceProjection {
  return {
    sessionId: 'session-1',
    turns: Array.from({ length: turnCount }, (_, index) => makeTurn(index)),
    activeTurnIndex,
  };
}

describe('TurnBasedTraceView focus helpers', () => {
  it('counts only leading history turns inserted before the previous first turn', () => {
    expect(getPrependedTurnCount('turn-1', [makeTurn(-2), makeTurn(-1), makeTurn(0)]))
      .toBe(2);
    expect(getPrependedTurnCount('turn-1', [makeTurn(0), makeTurn(1)]))
      .toBe(0);
    expect(getPrependedTurnCount('missing', [makeTurn(0), makeTurn(1)]))
      .toBe(0);
  });

  it('restores the same visible turn and pixel offset after history prepend', () => {
    const turns = [makeTurn(-2), makeTurn(-1), ...Array.from({ length: 3 }, (_, index) => makeTurn(index))];
    expect(getPrependAnchorScrollLocation(
      { sessionId: 'session-1', turnId: 'turn-2', offsetTop: 11.5 },
      'session-1',
      turns,
    )).toEqual({ index: 3, align: 'start', behavior: 'auto', offset: -11.5 });
    expect(getPrependAnchorScrollLocation(
      { sessionId: 'other-session', turnId: 'turn-2', offsetTop: 11.5 },
      'session-1',
      turns,
    )).toBeNull();
    expect(getPrependAnchorScrollCorrection(-24.25, 0)).toBe(24.25);
  });

  it('keeps a pending prepend anchor restore alive across streaming-only rerenders', () => {
    const initialProjection = makeProjection(-1, 2);
    const view = render(React.createElement(TurnBasedTraceView, { projection: initialProjection }));
    const scroller = view.getByTestId('virtuoso-scroller');
    scroller.getBoundingClientRect = () => rect(0, 500);
    const initialAnchor = view.container.querySelector<HTMLElement>('[data-trace-turn-id="turn-1"]');
    const initialSecondTurn = view.container.querySelector<HTMLElement>('[data-trace-turn-id="turn-2"]');
    expect(initialAnchor).not.toBeNull();
    expect(initialSecondTurn).not.toBeNull();
    initialAnchor!.getBoundingClientRect = () => rect(20, 100);
    initialSecondTurn!.getBoundingClientRect = () => rect(120, 200);

    act(() => {
      flushAnimationFrames();
      vi.runOnlyPendingTimers();
    });
    mocks.scrollToIndex.mockClear();

    const prependedProjection: TraceProjection = {
      ...initialProjection,
      turns: [makeTurn(-1), ...initialProjection.turns],
    };
    view.rerender(React.createElement(TurnBasedTraceView, { projection: prependedProjection }));
    const restoredAnchor = view.container.querySelector<HTMLElement>('[data-trace-turn-id="turn-1"]');
    expect(restoredAnchor).not.toBeNull();
    restoredAnchor!.getBoundingClientRect = () => rect(60, 140);

    view.rerender(React.createElement(TurnBasedTraceView, {
      projection: {
        ...prependedProjection,
        turns: prependedProjection.turns.map((turn) => ({ ...turn, nodes: [...turn.nodes] })),
      },
    }));

    act(() => {
      flushAnimationFrames();
      vi.runOnlyPendingTimers();
      flushAnimationFrames();
      vi.runOnlyPendingTimers();
    });

    expect(mocks.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'start',
      behavior: 'auto',
      offset: -20,
    });
    expect(scroller.scrollTop).toBe(40);
  });

  it('focuses the active turn while a run is streaming', () => {
    expect(getFocusedTurnIndex(makeProjection(1))).toBe(1);
  });

  it('falls back to the latest turn when no turn is active', () => {
    expect(getFocusedTurnIndex(makeProjection(-1))).toBe(2);
  });

  it('returns -1 when there are no turns', () => {
    expect(getFocusedTurnIndex(makeProjection(-1, 0))).toBe(-1);
  });

  it('uses the active turn as the output follow target while streaming', () => {
    expect(getOutputFollowTurnIndex(makeProjection(1), null, false)).toBe(1);
  });

  it('keeps following the completed turn after streaming finishes', () => {
    expect(getOutputFollowTurnIndex(makeProjection(-1), 'turn-2', true)).toBe(1);
  });

  it('stops following completed output after the user leaves the bottom', () => {
    expect(getOutputFollowTurnIndex(makeProjection(-1), 'turn-2', false)).toBe(-1);
  });

  it('does not force bottom-follow when the viewport is away from the bottom', () => {
    expect(shouldFollowTurnOutput(false)).toBe(false);
    expect(shouldFollowTurnOutput(true)).toBe('auto');
  });

  it('treats short or near-bottom scrollers as bottom anchored', () => {
    expect(isScrollerNearBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 700 })).toBe(true);
    expect(isScrollerNearBottom({ scrollHeight: 900, scrollTop: 120, clientHeight: 700 })).toBe(true);
    expect(isScrollerNearBottom({ scrollHeight: 1200, scrollTop: 200, clientHeight: 700 })).toBe(false);
  });

  it('keeps the active output visible after the view programmatically focused a new turn', () => {
    expect(shouldFollowTurnOutput(false, true)).toBe('auto');
    expect(shouldFollowTurnOutput(true, true)).toBe('auto');
  });

  it('pauses programmatic follow while the user is actively scrolling', () => {
    expect(shouldFollowTurnOutput(true, false, true)).toBe(false);
    expect(shouldFollowTurnOutput(true, true, true)).toBe(false);
  });

  it('suppresses programmatic scroll briefly after a user scroll gesture', () => {
    const now = 1_000;
    const until = getUserScrollSuppressionUntil(now);

    expect(until).toBe(now + USER_SCROLL_PROGRAMMATIC_PAUSE_MS);
    expect(isProgrammaticScrollSuppressed(until, until - 1)).toBe(true);
    expect(isProgrammaticScrollSuppressed(until, until)).toBe(false);
  });

  // 2026-07-28 用户反馈：触控板惯性拉到最底、手停后页面快速抖几下。
  // 跟随恢复窗口必须明显长于普通程序滚动抑制，让惯性/橡皮筋沉降干净后才钉底。
  it('holds follow re-engagement longer than the generic scroll pause (inertia settle)', () => {
    expect(USER_SCROLL_FOLLOW_REENGAGE_PAUSE_MS).toBeGreaterThan(USER_SCROLL_PROGRAMMATIC_PAUSE_MS * 2);

    const now = 1_000;
    const until = getUserScrollSuppressionUntil(now, USER_SCROLL_FOLLOW_REENGAGE_PAUSE_MS);
    expect(until).toBe(now + USER_SCROLL_FOLLOW_REENGAGE_PAUSE_MS);
    // 普通抑制（280ms）到期时，跟随恢复抑制仍在
    expect(isProgrammaticScrollSuppressed(until, now + USER_SCROLL_PROGRAMMATIC_PAUSE_MS + 1)).toBe(true);
    expect(isProgrammaticScrollSuppressed(until, until)).toBe(false);
  });

  it('only stops output following for gestures that move toward older content', () => {
    expect(shouldStopFollowingForWheel(-1)).toBe(true);
    expect(shouldStopFollowingForWheel(1)).toBe(false);
    expect(shouldStopFollowingForTouchMove(100, 104)).toBe(true);
    expect(shouldStopFollowingForTouchMove(100, 97)).toBe(false);
    expect(shouldStopFollowingForTouchMove(null, 104)).toBe(false);
    expect(shouldStopFollowingForKeyboardScroll('ArrowUp')).toBe(true);
    expect(shouldStopFollowingForKeyboardScroll('PageDown')).toBe(false);
    expect(shouldStopFollowingForKeyboardScroll(' ', true)).toBe(true);
    expect(shouldStopFollowingForKeyboardScroll(' ', false)).toBe(false);
  });

  it('throttles active display scroll scheduling within the display interval', () => {
    expect(getActiveDisplayScrollDelay(0, 1_000)).toBe(0);
    expect(getActiveDisplayScrollDelay(1_000, 1_020)).toBe(
      ACTIVE_DISPLAY_SCROLL_INTERVAL_MS - 20,
    );
    expect(getActiveDisplayScrollDelay(1_000, 1_200)).toBe(0);
  });

  it('only shows turn time separators for the first turn or meaningful gaps', () => {
    expect(shouldShowTurnTimeSeparator(null, { startTime: 1_000 })).toBe(true);
    expect(shouldShowTurnTimeSeparator({ startTime: 1_000 }, { startTime: 60_000 })).toBe(false);
    expect(shouldShowTurnTimeSeparator({ startTime: 1_000 }, { startTime: 301_000 })).toBe(true);
  });

  it('finds the first assistant text node in the active turn', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'streaming',
          startTime: 100,
          nodes: [
            { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
            { id: 'assistant-1', type: 'assistant_text', content: 'answer', timestamp: 120 },
          ],
        },
      ],
    };

    expect(getActiveAssistantTextAnchor(projection)).toEqual({
      turnIndex: 0,
      nodeId: 'assistant-1',
      nodeType: 'assistant_text',
    });
  });

  it('changes the active output revision when streaming text grows', () => {
    const baseTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
        { id: 'assistant-1', type: 'assistant_text', content: 'short answer', timestamp: 120 },
      ],
    };
    const nextTurn: TraceTurn = {
      ...baseTurn,
      nodes: [
        baseTurn.nodes[0],
        {
          ...baseTurn.nodes[1],
          content: 'short answer with more streamed content',
        },
      ],
    };

    expect(getTurnOutputRevision(nextTurn)).not.toBe(getTurnOutputRevision(baseTurn));
  });

  it('can ignore streaming assistant text length so display pacing drives scroll', () => {
    const baseTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
        { id: 'assistant-1', type: 'assistant_text', content: 'short answer', timestamp: 120 },
      ],
    };
    const nextTurn: TraceTurn = {
      ...baseTurn,
      nodes: [
        baseTurn.nodes[0],
        {
          ...baseTurn.nodes[1],
          content: 'short answer with more streamed content',
        },
      ],
    };

    expect(
      getTurnOutputRevision(nextTurn, { includeAssistantContentLength: false }),
    ).toBe(getTurnOutputRevision(baseTurn, { includeAssistantContentLength: false }));
  });

  it('can ignore hidden thinking length so collapsed reasoning does not drive scroll', () => {
    const baseTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
        {
          id: 'assistant-1',
          type: 'assistant_text',
          content: '',
          reasoning: 'thinking',
          timestamp: 120,
        },
      ],
    };
    const nextTurn: TraceTurn = {
      ...baseTurn,
      nodes: [
        baseTurn.nodes[0],
        {
          ...baseTurn.nodes[1],
          reasoning: 'thinking with more streamed hidden reasoning',
        },
      ],
    };

    expect(getTurnOutputRevision(nextTurn)).not.toBe(getTurnOutputRevision(baseTurn));
    expect(
      getTurnOutputRevision(nextTurn, { includeThinkingLength: false }),
    ).toBe(getTurnOutputRevision(baseTurn, { includeThinkingLength: false }));
  });

  it('builds a selector for trace node anchors', () => {
    expect(getTraceNodeSelector('assistant-1', 'assistant_text')).toBe(
      '[data-trace-node-id="assistant-1"][data-trace-node-type="assistant_text"]',
    );
  });

  it('builds a selector for trace turn anchors', () => {
    expect(getTraceTurnSelector('turn-"1"')).toBe(
      '[data-trace-turn-id="turn-\\"1\\""]',
    );
  });
});

describe('TurnBasedTraceView streaming scroll drivers', () => {
  function makeStreamingTurn(overrides: Partial<TraceTurn> = {}): TraceTurn {
    return {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
        { id: 'assistant-live', type: 'assistant_text', content: 'partial answer', timestamp: 120 },
      ],
      ...overrides,
    };
  }

  function makeStreamingProjection(turn: TraceTurn): TraceProjection {
    return { sessionId: 'session-1', turns: [turn], activeTurnIndex: 0 };
  }

  function flushView(): void {
    act(() => {
      flushAnimationFrames();
      vi.runOnlyPendingTimers();
    });
  }

  it('流式跟随期间 output revision 变化不再触发 scrollToIndex（followOutput 单独吸底）', () => {
    const turn = makeStreamingTurn();
    const view = render(React.createElement(TurnBasedTraceView, { projection: makeStreamingProjection(turn) }));
    flushView();
    mocks.scrollToIndex.mockClear();

    // 工具边界：追加 tool_call 节点 → outputFollowRevision 变化
    const withTool: TraceTurn = {
      ...turn,
      nodes: [...turn.nodes, { id: 'tool-1', type: 'tool_call', content: '', timestamp: 130 }],
    };
    view.rerender(React.createElement(TurnBasedTraceView, { projection: makeStreamingProjection(withTool) }));
    flushView();

    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
  });

  it('流式跟随期间 ResizeObserver 只观察活动 turn 且高度变化不再调度 scrollToIndex', () => {
    let observerCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
    });

    const streamingTurn = makeStreamingTurn({ turnNumber: 2, turnId: 'turn-2', startTime: 200 });
    const projection: TraceProjection = {
      sessionId: 'session-1',
      turns: [makeTurn(0), streamingTurn],
      activeTurnIndex: 1,
    };
    render(React.createElement(TurnBasedTraceView, { projection }));
    flushView();

    const observed = observe.mock.calls.map((call) => call[0] as HTMLElement);
    // 观察面收窄：所有 observer（吸底调度 + 流式 min-height 锁）都只观察跟随中的
    // 活动 turn，而不是所有已挂载 turn
    expect(observed.length).toBeGreaterThanOrEqual(1);
    for (const el of observed) {
      expect(el.dataset.traceTurnId).toBe('turn-2');
    }

    mocks.scrollToIndex.mockClear();
    act(() => {
      observerCallback?.([
        { target: observed[0], contentRect: rect(0, 480) } as unknown as ResizeObserverEntry,
      ], {} as ResizeObserver);
    });
    act(() => {
      vi.advanceTimersByTime(ACTIVE_DISPLAY_SCROLL_INTERVAL_MS + 20);
      flushAnimationFrames();
      vi.runOnlyPendingTimers();
    });

    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
  });

  it('流式跟随期间 assistant anchor id 翻转不再上拉（无 align start / scrollIntoView）', () => {
    const scrollIntoView = vi.fn();
    const turn = makeStreamingTurn();
    const view = render(React.createElement(TurnBasedTraceView, { projection: makeStreamingProjection(turn) }));
    const scroller = view.getByTestId('virtuoso-scroller');
    flushView();
    mocks.scrollToIndex.mockClear();

    // 流式 overlay 临时节点消失、正式节点出现 → anchor id 翻转（TurnCard 已 mock，
    // 手工补一个带 data 属性的新 anchor 元素，模拟真实挂载）
    const anchorElement = document.createElement('div');
    anchorElement.dataset.traceNodeId = 'assistant-final';
    anchorElement.dataset.traceNodeType = 'assistant_text';
    (anchorElement as HTMLElement & { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    scroller.appendChild(anchorElement);

    const flipped: TraceTurn = {
      ...turn,
      nodes: [
        turn.nodes[0],
        { ...turn.nodes[1], id: 'assistant-final' },
      ],
    };
    view.rerender(React.createElement(TurnBasedTraceView, { projection: makeStreamingProjection(flipped) }));
    flushView();

    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('流式结束后跟随窗口内 revision 变化仍会 settle 到底部', () => {
    const turn = makeStreamingTurn();
    const view = render(React.createElement(TurnBasedTraceView, { projection: makeStreamingProjection(turn) }));
    flushView();
    mocks.scrollToIndex.mockClear();

    const completed: TraceTurn = { ...turn, status: 'completed', endTime: 300 };
    view.rerender(React.createElement(TurnBasedTraceView, {
      projection: { sessionId: 'session-1', turns: [completed], activeTurnIndex: -1 },
    }));
    flushView();

    expect(mocks.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'auto',
    });
  });

  it('非 streaming 的历史会话进入：初始落点钉在底部，不再把末轮顶置到视口顶部', () => {
    const projection: TraceProjection = {
      sessionId: 'session-2',
      activeTurnIndex: -1,
      turns: [{ ...makeStreamingTurn(), status: 'completed' }],
    };
    render(React.createElement(TurnBasedTraceView, { projection }));
    flushView();

    // 进入瞬间没有任何把 focused turn 钉到视口顶部的程序滚动
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
    // 首帧定位交给 Virtuoso：最后一条内容末尾对齐视口底部，无动画，底部锚定抗沉降
    expect(mocks.virtuosoProps.initialTopMostItemIndex).toEqual({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    });
    expect(mocks.virtuosoProps.alignToBottom).toBe(true);
  });

  it('streaming 会话进入：不再先把活动轮钉到视口顶部（首帧即底部，followOutput 持续吸底）', () => {
    const view = render(React.createElement(TurnBasedTraceView, {
      projection: makeStreamingProjection(makeStreamingTurn()),
    }));
    flushView();

    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
    expect(mocks.virtuosoProps.initialTopMostItemIndex).toEqual({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    });

    // 抵达底部后 atBottomStateChange 恢复跟随：后续流式 settle 仍走既有机制
    act(() => {
      mocks.virtuosoProps.atBottomStateChange(true);
    });
    mocks.scrollToIndex.mockClear();
    const completed: TraceTurn = { ...makeStreamingTurn(), status: 'completed', endTime: 300 };
    view.rerender(React.createElement(TurnBasedTraceView, {
      projection: { sessionId: 'session-1', turns: [completed], activeTurnIndex: -1 },
    }));
    flushView();
    expect(mocks.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'end',
      behavior: 'auto',
    });
  });

  it('切换会话时 Virtuoso 以 sessionId 为 key 重挂载，每个会话都重新应用底部初始落点', () => {
    const first: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [{ ...makeStreamingTurn(), status: 'completed' }],
    };
    const view = render(React.createElement(TurnBasedTraceView, { projection: first }));
    flushView();
    const firstScroller = view.getByTestId('virtuoso-scroller');

    const second: TraceProjection = {
      sessionId: 'session-2',
      activeTurnIndex: -1,
      turns: [{ ...makeStreamingTurn({ turnId: 'turn-x' }), status: 'completed' }],
    };
    mocks.scrollToIndex.mockClear();
    view.rerender(React.createElement(TurnBasedTraceView, { projection: second }));
    flushView();

    // key 变化 → 重挂载 → 新的 scroller 元素，initialTopMostItemIndex 重新生效
    expect(view.getByTestId('virtuoso-scroller')).not.toBe(firstScroller);
    // 切换后不做任何顶置程序滚动（落点由重挂载的首帧定位负责）
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
  });

  it('同一会话内新轮开始（非进入场景）仍把新轮顶置到视口上方', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [{ ...makeStreamingTurn(), status: 'completed' }],
    };
    const view = render(React.createElement(TurnBasedTraceView, { projection }));
    flushView();
    mocks.scrollToIndex.mockClear();

    const newTurn = makeStreamingTurn({ turnNumber: 2, turnId: 'turn-2', startTime: 200 });
    view.rerender(React.createElement(TurnBasedTraceView, {
      projection: { sessionId: 'session-1', turns: [projection.turns[0], newTurn], activeTurnIndex: 1 },
    }));
    flushView();

    expect(mocks.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'start',
      behavior: 'auto',
    });
  });
});

// 渲染反馈环回归（2026-07-30 P0）：react-virtuoso 每次渲染都在 layout effect 里
// 全量发布 props 到自己的 store，发布即通知订阅者（useSyncExternalStore →
// forceStoreRerender）。所以任何"每渲染换身份"的 props 都会把上游一次普通重渲染
// 放大成一轮同步嵌套更新——上游只要有高频重渲染源，就打满 React 50 层上限报 #185。
// 守的不变量：props 值没变时，交给 Virtuoso 的 itemContent 必须保持同一个引用。
describe('TurnBasedTraceView 不向虚拟列表灌入每渲染变身份的 props', () => {
  it('相同 props 重渲染时 itemContent 引用保持稳定（含省略 searchMatches 的默认档）', () => {
    const projection = makeProjection(-1);
    const beforeFirstUserMessage = React.createElement('div', null, 'fork-hint');

    const view = render(React.createElement(TurnBasedTraceView, {
      projection,
      beforeFirstUserMessage,
    }));
    const firstItemContent = mocks.virtuosoProps.itemContent;

    view.rerender(React.createElement(TurnBasedTraceView, {
      projection,
      beforeFirstUserMessage,
    }));

    expect(mocks.virtuosoProps.itemContent).toBe(firstItemContent);
  });

  it('调用方不传 searchMatches 时默认值不得每渲染新建数组', () => {
    const projection = makeProjection(-1);

    const view = render(React.createElement(TurnBasedTraceView, { projection }));
    const firstSearchMatches = mocks.virtuosoProps.itemContent;

    view.rerender(React.createElement(TurnBasedTraceView, { projection }));

    expect(mocks.virtuosoProps.itemContent).toBe(firstSearchMatches);
  });
});
