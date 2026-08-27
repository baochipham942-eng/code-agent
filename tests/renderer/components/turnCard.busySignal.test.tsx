// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({
    node,
  }: {
    node: { type: string; content?: string };
  }) => React.createElement('div', null, node.content),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: ({
    showCaret,
    waitingReason,
  }: {
    showCaret?: boolean;
    waitingReason?: string;
  }) => (
    showCaret && !waitingReason
      ? React.createElement('span', { 'data-testid': 'streaming-caret' }, '▎')
      : null
  ),
  getRunningToolStartTime: () => undefined,
  getRunningSubagentCount: () => 0,
  getStreamingWaitingReason: () => undefined,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', { 'data-testid': 'tool-running' }, 'tool running'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const baseTime = 1_800_000_000_000;

function makeTurn(nodes: TraceTurn['nodes']): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'streaming',
    startTime: baseTime - 1_000,
    nodes: [
      { id: 'user-1', type: 'user', content: '处理一下', timestamp: baseTime - 1_000 },
      ...nodes,
    ],
  };
}

function completedTool(): TraceTurn['nodes'][number] {
  return {
    id: 'tool-completed',
    type: 'tool_call',
    content: '',
    timestamp: baseTime,
    toolCall: { id: 'call-completed', name: 'Read', args: {}, result: 'ok', success: true },
  };
}

describe('TurnCard busy signal', () => {
  it('思考阶段只渲染正在思考头，不渲染流式光标', () => {
    vi.setSystemTime(baseTime + 2_300);
    render(<TurnCard turn={makeTurn([
      completedTool(),
      {
        id: 'thinking-1',
        type: 'assistant_text',
        content: '',
        reasoning: '正在核对约束。',
        timestamp: baseTime + 100,
      },
    ])} />);

    expect(screen.getByText(/正在思考… · 3s/)).toBeTruthy();
    expect(screen.queryByTestId('streaming-caret')).toBeNull();
  });

  it('文本流式阶段只渲染文本尾光标，思考头不带正在态', () => {
    vi.setSystemTime(baseTime + 2_300);
    render(<TurnCard turn={makeTurn([{
      id: 'answer-1',
      type: 'assistant_text',
      content: '开始输出正文',
      reasoning: '已经完成分析。',
      timestamp: baseTime,
    }])} />);

    expect(screen.getAllByTestId('streaming-caret')).toHaveLength(1);
    expect(screen.queryByText(/正在思考/)).toBeNull();
  });

  it('工具执行阶段由步骤行独占进行中态，思考头和光标都不渲染', () => {
    render(<TurnCard turn={makeTurn([
      {
        id: 'tool-running',
        type: 'tool_call',
        content: '',
        timestamp: baseTime,
        toolCall: { id: 'call-running', name: 'Bash', args: {} },
      },
      {
        id: 'synthetic-tail',
        type: 'assistant_text',
        content: '',
        timestamp: baseTime + 100,
      },
    ])} />);

    expect(screen.getByTestId('tool-running')).toBeTruthy();
    expect(screen.queryByText(/正在思考/)).toBeNull();
    expect(screen.queryByTestId('streaming-caret')).toBeNull();
  });
});
