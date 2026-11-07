// @vitest-environment jsdom
// ============================================================================
// N-MEM-JOURNAL-SOURCEJUMP r3：pendingSearchJump 落点管线的两处回归钉子。
// ① ChatSearchBar：空 query 的 matches 回推只在「用户清空了非空输入」时发生。
//    此前投影重算（turns 引用变化）也带空 query 回推 []，把跳转刚种下的高亮
//    在同一秒内抹掉（真跑诊断：ChatView MATCH branch 已执行、amber 始终 0）。
// ② TurnBasedTraceView：搜索命中滚动用 settlement（跨帧重发 scrollToIndex），
//    不再是一次性调用——挂载测量窗口里一次调用会被末轮锚定顶掉。
// ============================================================================

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import type { SearchMatch } from '../../../src/renderer/components/features/chat/ChatSearchBar';

vi.mock('../../../src/renderer/services/ipcService', () => {
  const instance = { invoke: vi.fn() };
  return { ipcService: instance, default: instance };
});

const scrollToIndexMock = vi.hoisted(() => vi.fn());
vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(props: Record<string, any>, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: scrollToIndexMock }));
      return ReactModule.createElement(
        'div',
        { 'data-testid': 'virtuoso-scroller', ref: props.scrollerRef },
        props.data.map((turn: any, index: number) => ReactModule.createElement(
          ReactModule.Fragment,
          { key: turn.turnId },
          props.itemContent(props.firstItemIndex + index, turn),
        )),
      );
    }),
  };
});

import { ChatSearchBar } from '../../../src/renderer/components/features/chat/ChatSearchBar';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';

const now = 1_000;

function projection(): TraceProjection {
  return {
    sessionId: 'session-1',
    turns: [
      { turnNumber: 1, turnId: 'turn-1', nodes: [{ id: 'm1', type: 'user', content: 'first message', timestamp: now }], status: 'completed', startTime: now, endTime: now },
      { turnNumber: 2, turnId: 'turn-2', nodes: [{ id: 'm2', type: 'user', content: 'target message with marker', timestamp: now + 1 }], status: 'completed', startTime: now + 1, endTime: now + 1 },
      { turnNumber: 3, turnId: 'turn-3', nodes: [{ id: 'm3', type: 'user', content: 'last message', timestamp: now + 2 }], status: 'completed', startTime: now + 2, endTime: now + 2 },
    ],
    activeTurnIndex: -1,
  };
}

function flushFrames(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('ChatSearchBar — empty-query matches push (r3 ①)', () => {
  function renderBar(
    onMatchesChange: ReturnType<typeof vi.fn<(matches: SearchMatch[], activeIndex: number) => void>>,
    proj: TraceProjection,
  ) {
    return render(
      <ChatSearchBar
        visible
        projection={proj}
        onClose={() => {}}
        onMatchesChange={onMatchesChange}
        onActiveMatchChange={() => {}}
      />,
    );
  }

  it('does not push empty matches on mount or projection churn while the query stays empty', async () => {
    const onMatchesChange = vi.fn();
    const emptyTurns = { ...projection(), turns: [] } as TraceProjection;
    const { rerender } = renderBar(onMatchesChange, emptyTurns);
    await flushFrames(50);
    // 挂载首跑：空 query 不回推
    expect(onMatchesChange).not.toHaveBeenCalled();

    // 投影重算（turns 引用变化）+ 仍空 query：不回推——这正是抹掉跳转高亮的路径
    const churned = { ...projection(), turns: [] } as TraceProjection;
    rerender(
      <ChatSearchBar
        visible
        projection={churned}
        onClose={() => {}}
        onMatchesChange={onMatchesChange}
        onActiveMatchChange={() => {}}
      />,
    );
    await flushFrames(50);
    expect(onMatchesChange).not.toHaveBeenCalled();
  });

  it('pushes matches when the user types, and clears them when the user empties the query', async () => {
    const onMatchesChange = vi.fn();
    renderBar(onMatchesChange, projection());
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();

    // React 受控输入需要 native setter 驱动
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, 'target');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushFrames(50);
    expect(onMatchesChange).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ turnIndex: 1 })]),
      0,
    );

    // 清空输入 → 用户清空 → 回推空
    nativeSetter?.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushFrames(50);
    expect(onMatchesChange).toHaveBeenCalledWith([], 0);
  });
});

describe('TurnBasedTraceView — search-match scroll settlement (r3 ②)', () => {
  it('re-issues scrollToIndex across frames until the target settles (not a one-shot)', async () => {
    render(
      <TurnBasedTraceView
        projection={projection()}
        searchMatches={[{ turnIndex: 1, nodeIndex: 0, offset: 0 }]}
        activeMatchIndex={0}
      />,
    );
    // jsdom 里 rect 全 0：spanning 判据会立即成立——把目标轮元素改成
    // 「不居中也不铺满」的形状，settlement 必须跨帧持续重发。
    const turnEl = document.querySelector('[data-trace-turn-id="turn-2"]') as HTMLElement;
    expect(turnEl).not.toBeNull();
    turnEl.getBoundingClientRect = () => ({
      top: 0, bottom: 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement;
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: 600, left: 0, right: 500, width: 500, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    await flushFrames(120);
    expect(scrollToIndexMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of scrollToIndexMock.mock.calls) {
      expect(call[0]).toMatchObject({ index: 1, align: 'center', behavior: 'auto' });
    }
  });
});
