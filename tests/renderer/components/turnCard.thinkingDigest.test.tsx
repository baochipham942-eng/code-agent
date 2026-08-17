// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => React.createElement('div', { 'data-testid': 'streaming-indicator' }),
  getRunningToolStartTime: () => undefined,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => undefined,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const baseTime = 1_800_000_000_000;

function reasoningNode(id: string, reasoning: string, timestamp = baseTime, content = ''): TraceTurn['nodes'][number] {
  return { id, type: 'assistant_text', content, timestamp, reasoning } as TraceTurn['nodes'][number];
}

function toolNode(id: string, timestamp: number): TraceTurn['nodes'][number] {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp,
    toolCall: { id: `${id}-call`, name: 'Bash', args: {}, success: true, result: 'ok' },
  } as TraceTurn['nodes'][number];
}

function makeTurn(nodes: TraceTurn['nodes'], status: TraceTurn['status'] = 'streaming'): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status,
    startTime: baseTime - 1_000,
    endTime: status === 'completed' ? baseTime + 5_000 : undefined,
    nodes: [
      { id: 'user-1', type: 'user', content: '帮我查一下', timestamp: baseTime - 1_000 },
      ...nodes,
    ],
  };
}

function getThinkingToggle(): HTMLButtonElement {
  return screen.getByTestId('thinking-digest').querySelector('button') as HTMLButtonElement;
}

describe('TurnCard 思考展示状态机', () => {
  it('reasoning delta 出现时默认展开，并由思考块独占「正在思考」信号', () => {
    vi.setSystemTime(baseTime + 2_300);
    render(<TurnCard turn={makeTurn([reasoningNode('reasoning-1', '正在核对文件结构。')])} />);

    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/正在思考… · 3s/)).not.toBeNull();
    expect(screen.getByText('正在核对文件结构。')).not.toBeNull();
    expect(screen.getByTestId('streaming-indicator').textContent).toBe('');
  });

  it('自动展开后，第一段正文出现才自动收起成带时长和段数的横幅', async () => {
    vi.setSystemTime(baseTime + 2_300);
    const streamingReasoning = reasoningNode('reasoning-1', '先分析约束。');
    const { rerender } = render(<TurnCard turn={makeTurn([streamingReasoning])} />);
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');

    // reasoning 与正文之间的空窗仍保持展开；不能把“当前没新 delta”误当成正文边界。
    rerender(<TurnCard turn={makeTurn([{ ...streamingReasoning }])} />);
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');

    act(() => vi.setSystemTime(baseTime + 3_600));
    rerender(<TurnCard turn={makeTurn([{ ...streamingReasoning, content: '第一段正文' }])} />);

    await waitFor(() => expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false'));
    expect(getThinkingToggle().textContent).toContain('思考 4s · 1 段');
  });

  it('用户手动收起后，本轮正文与后续 reasoning 段都不能再改动展开状态', async () => {
    vi.setSystemTime(baseTime + 1_000);
    const firstReasoning = reasoningNode('reasoning-1', '第一段。');
    const { rerender } = render(<TurnCard turn={makeTurn([firstReasoning])} />);

    fireEvent.click(getThinkingToggle());
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');

    rerender(<TurnCard turn={makeTurn([{ ...firstReasoning, content: '正文一' }])} />);
    await waitFor(() => expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false'));

    rerender(<TurnCard turn={makeTurn([
      { ...firstReasoning, content: '正文一' },
      toolNode('tool-1', baseTime + 2_000),
      reasoningNode('reasoning-2', '第二段。', baseTime + 3_000),
    ])} />);
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('工具隔断当前段时收起，后续新 reasoning 段流入时再次展开', async () => {
    vi.setSystemTime(baseTime + 1_000);
    const firstReasoning = reasoningNode('reasoning-1', '第一段。');
    const { rerender } = render(<TurnCard turn={makeTurn([firstReasoning])} />);
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');

    rerender(<TurnCard turn={makeTurn([
      firstReasoning,
      toolNode('tool-1', baseTime + 2_000),
    ])} />);
    await waitFor(() => expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false'));

    rerender(<TurnCard turn={makeTurn([
      firstReasoning,
      toolNode('tool-1', baseTime + 2_000),
      reasoningNode('reasoning-2', '第二段。', baseTime + 3_000),
    ])} />);
    await waitFor(() => expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true'));
    expect(getThinkingToggle().textContent).toContain('正在思考');
    expect(screen.getByText('2. 第二段。')).not.toBeNull();
  });

  it('provider 完全没有 reasoning delta 时不出现空思考块', () => {
    render(<TurnCard turn={makeTurn([
      reasoningNode('answer-1', '', baseTime, '直接输出正文'),
    ])} />);
    expect(screen.queryByTestId('thinking-digest')).toBeNull();
  });

  it('prefers-reduced-motion 下滚动跟随使用直达模式', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render(<TurnCard turn={makeTurn([reasoningNode('reasoning-1', '直接展示。')])} />);

    const scroller = screen.getByTestId('thinking-digest').querySelector<HTMLElement>(
      '.thinking-digest-scroller',
    );
    expect(scroller?.style.scrollBehavior).toBe('auto');
  });

  it('手动展开完成态后，自动逻辑不再把它收回去', () => {
    const completed = makeTurn([
      reasoningNode('reasoning-1', '完整思考。'),
      toolNode('tool-1', baseTime + 2_000),
      reasoningNode('answer-1', '', baseTime + 3_000, '正文'),
    ], 'completed');
    render(<TurnCard turn={completed} defaultExpanded />);

    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(getThinkingToggle());
    expect(getThinkingToggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('thinking-digest').getAttribute('data-user-interacted')).toBe('true');
  });
});

describe('思考容器贴底判定', () => {
  it('距底 2px 以内跟随，用户上滚到 3px 后停止抢滚动', () => {
    const firstReasoning = reasoningNode('reasoning-1', '第一行');
    const { rerender } = render(<TurnCard turn={makeTurn([firstReasoning])} />);
    const scroller = screen.getByTestId('thinking-digest').querySelector<HTMLElement>(
      '.thinking-digest-scroller',
    )!;
    let scrollHeight = 100;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 20 });

    scroller.scrollTop = 78;
    fireEvent.scroll(scroller);
    scrollHeight = 120;
    rerender(<TurnCard turn={makeTurn([{ ...firstReasoning, reasoning: '第一行\n第二行' }])} />);
    expect(scroller.scrollTop).toBe(120);

    scroller.scrollTop = 97;
    fireEvent.scroll(scroller);
    scrollHeight = 140;
    rerender(<TurnCard turn={makeTurn([{ ...firstReasoning, reasoning: '第一行\n第二行\n第三行' }])} />);
    expect(scroller.scrollTop).toBe(97);
  });
});
