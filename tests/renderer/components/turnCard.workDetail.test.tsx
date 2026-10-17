// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { useAppStore, type DisclosureLevel } from '../../../src/renderer/stores/appStore';

function readTool(id: string, timestamp: number): TraceNode {
  return {
    id,
    type: 'tool_call',
    content: '',
    timestamp,
    toolCall: {
      id: `${id}-call`,
      name: 'Read',
      args: { file_path: '/work/notes.md' },
      success: true,
      result: 'ok',
    },
  } as TraceNode;
}

function completedTurn(extraTools = 0): TraceTurn {
  const nodes: TraceNode[] = [
    { id: 'user-1', type: 'user', content: '帮我看一下', timestamp: 1_000 } as TraceNode,
    readTool('tool-1', 2_000),
  ];
  for (let index = 0; index < extraTools; index += 1) {
    nodes.push(readTool(`tool-extra-${index}`, 3_000 + index));
  }
  nodes.push({
    id: 'assistant-1',
    type: 'assistant_text',
    content: '看完了。',
    timestamp: 30_000,
    reasoning: '先读文件。',
  } as TraceNode);
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 1_000,
    endTime: 31_000,
    nodes,
  };
}

function renderAt(level: DisclosureLevel, turn: TraceTurn, forceExpanded = false) {
  useAppStore.setState({ disclosureLevel: level, language: 'zh' });
  return render(<TurnCard turn={turn} forceExpanded={forceExpanded} />);
}

// 末轮收尾折叠（2026-10-17 拍板 B）专用：5 节点轮，simple/standard 两档都可折叠，
// 中间藏得住 3 个工具调用。
function foldableTurn(status: 'streaming' | 'completed'): TraceTurn {
  const turn = completedTurn(2);
  return status === 'completed' ? { ...turn, status } : { ...turn, status, endTime: undefined };
}

function renderLastTurn(level: DisclosureLevel, turn: TraceTurn, defaultExpanded: boolean) {
  useAppStore.setState({ disclosureLevel: level, language: 'zh' });
  return render(<TurnCard turn={turn} defaultExpanded={defaultExpanded} isLastTurn />);
}

const foldRow = () => screen.getByRole('button', { name: /用时/ });
// 工具组头（折叠态整块消失，展开态在场）；文案随聚合条数变，锚 testid 不变
const toolGroupLabel = () => screen.getByTestId('tool-group-head-label');

describe('TurnCard work detail policy', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  });

  it('a completed 3-node turn folds under simple but not standard', () => {
    const turn = completedTurn();
    expect(turn.nodes).toHaveLength(3);

    const { unmount } = renderAt('simple', turn);
    const folded = screen.getByRole('button', { name: /用时/ });
    expect(folded.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/读取了/)).toBeNull();
    unmount();

    renderAt('standard', turn);
    expect(screen.queryByRole('button', { name: /用时/ })).toBeNull();
    expect(screen.getByText(/读取了/)).not.toBeNull();
  });

  it('a long completed turn never folds under advanced or expert', () => {
    const turn = completedTurn(8);
    expect(turn.nodes.length).toBeGreaterThan(5);

    const { unmount } = renderAt('advanced', turn);
    expect(screen.queryByRole('button', { name: /用时/ })).toBeNull();
    unmount();

    renderAt('expert', turn);
    expect(screen.queryByRole('button', { name: /用时/ })).toBeNull();
  });

  it('ThinkingDigestBanner is absent under simple', () => {
    const turn = completedTurn();
    const { unmount } = renderAt('simple', turn, true);
    expect(screen.queryByTestId('thinking-digest')).toBeNull();
    unmount();

    renderAt('standard', turn, true);
    expect(screen.getByTestId('thinking-digest')).not.toBeNull();
  });

  it('keeps the thinking banner during a streaming turn under simple', () => {
    const turn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-stream',
      status: 'streaming',
      startTime: 1_000,
      nodes: [
        { id: 'user-1', type: 'user', content: '帮我看一下', timestamp: 1_000 } as TraceNode,
        {
          id: 'thinking-1',
          type: 'assistant_text',
          content: '',
          reasoning: '先读文件。',
          timestamp: 2_000,
        } as TraceNode,
      ],
    };

    renderAt('simple', turn);
    expect(screen.getByTestId('thinking-digest')).not.toBeNull();
    expect(screen.getByText(/正在思考/)).toBeTruthy();
    expect(document.querySelector('.streaming-caret')).toBeNull();
    expect(screen.queryByTestId('streaming-preparation-indicator')).toBeNull();
  });

  it('tool groups start expanded only under expert', () => {
    const turn = completedTurn();
    for (const level of ['simple', 'standard', 'advanced', 'expert'] as const) {
      const { unmount } = renderAt(level, turn, true);
      const group = screen.getByTestId('tool-group-head-label').closest('button');
      expect(group?.getAttribute('aria-expanded')).toBe(level === 'expert' ? 'true' : 'false');
      unmount();
    }
  });
});

describe('TurnCard 末轮收尾折叠（simple 默认折，standard 保持展开）', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  });

  it('挂载即完成的末轮：simple 折成「用时」行，standard 展开', () => {
    const turn = foldableTurn('completed');

    const simple = renderLastTurn('simple', turn, false);
    expect(foldRow().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/读取了/)).toBeNull();
    simple.unmount();

    renderLastTurn('standard', turn, true);
    expect(foldRow().getAttribute('aria-expanded')).toBe('true');
    expect(toolGroupLabel()).not.toBeNull();
  });

  it('流式期间保持展开；收尾后 simple 自动折叠，standard 不折', () => {
    const streaming = foldableTurn('streaming');

    const simple = renderLastTurn('simple', streaming, true);
    expect(screen.queryByRole('button', { name: /用时/ })).toBeNull();
    expect(toolGroupLabel()).not.toBeNull();
    simple.rerender(<TurnCard turn={foldableTurn('completed')} defaultExpanded isLastTurn />);
    expect(foldRow().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('tool-group-head-label')).toBeNull();
    simple.unmount();

    const standard = renderLastTurn('standard', streaming, true);
    expect(toolGroupLabel()).not.toBeNull();
    standard.rerender(<TurnCard turn={foldableTurn('completed')} defaultExpanded isLastTurn />);
    expect(foldRow().getAttribute('aria-expanded')).toBe('true');
    expect(toolGroupLabel()).not.toBeNull();
  });

  it('收尾自动折叠后手动展开能站住：用户点过就不再被自动收', () => {
    const view = renderLastTurn('simple', foldableTurn('streaming'), true);
    view.rerender(<TurnCard turn={foldableTurn('completed')} defaultExpanded isLastTurn />);
    expect(foldRow().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(foldRow());
    expect(foldRow().getAttribute('aria-expanded')).toBe('true');
    expect(toolGroupLabel()).not.toBeNull();

    // 之后任何重渲染（节点再变）都不得把它收回去
    view.rerender(<TurnCard turn={foldableTurn('completed')} defaultExpanded isLastTurn />);
    expect(foldRow().getAttribute('aria-expanded')).toBe('true');
  });

  it('搜索强制展开压过折叠态（forceExpanded 仍赢）', () => {
    useAppStore.setState({ disclosureLevel: 'simple', language: 'zh' });
    render(<TurnCard turn={foldableTurn('completed')} forceExpanded />);
    expect(foldRow().getAttribute('aria-expanded')).toBe('true');
    expect(toolGroupLabel()).not.toBeNull();
  });

  it('纯问答轮（user + 结论两节点）不出「用时」空折叠行', () => {
    const turn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-qa',
      status: 'completed',
      startTime: 1_000,
      endTime: 2_000,
      nodes: [
        { id: 'user-1', type: 'user', content: '你好', timestamp: 1_000 } as TraceNode,
        { id: 'assistant-1', type: 'assistant_text', content: '你好，有什么可以帮你？', timestamp: 2_000 } as TraceNode,
      ],
    };

    const { unmount } = renderLastTurn('simple', turn, false);
    expect(screen.queryByRole('button', { name: /用时/ })).toBeNull();
    expect(screen.getByText('你好，有什么可以帮你？')).not.toBeNull();
    unmount();

    // 流式中的纯问答轮同样不折（canFold=false，正文照常流式）
    // 流式中的正文走打字机（首帧 0 字），不断言文本；断言的是不出折叠行
    renderLastTurn('simple', { ...turn, status: 'streaming', endTime: undefined }, true);
    expect(screen.queryByRole('button', { name: /用时/ })).toBeNull();
    expect(screen.getByText('你好')).not.toBeNull();
  });
});
