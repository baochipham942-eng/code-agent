// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
