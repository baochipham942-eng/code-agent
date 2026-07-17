import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
  getRunningToolStartTime: () => null,
  getStreamingWaitingReason: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard, shouldHideTurnRunHeader } from '../../../src/renderer/components/features/chat/TurnCard';

function makeStreamingTurnWithTools(): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'streaming',
    startTime: 100,
    nodes: [
      { id: 'user-1', type: 'user', content: 'do it', timestamp: 100 },
      {
        id: 'tc-1', type: 'tool_call', content: '', timestamp: 200,
        toolCall: { id: 'c1', name: 'Bash', args: {}, success: true, result: 'ok' },
      } as TraceTurn['nodes'][number],
      {
        id: 'tc-2', type: 'tool_call', content: '', timestamp: 210,
        toolCall: { id: 'c2', name: 'Bash', args: {}, success: true, result: 'ok' },
      } as TraceTurn['nodes'][number],
    ],
  };
}

// shouldHideTurnRunHeader 吃状态 key（稳定枚举），不吃人话 label——防止逻辑判断被
// i18n 文案变化打断（状态直出拆分：key 与 label 分离）。
describe('shouldHideTurnRunHeader — 按 key/tone 判断,与 label 文案无关', () => {
  it('running / using_tools / waiting_tool 三个 key 一律隐藏顶部横幅', () => {
    expect(shouldHideTurnRunHeader('running', 'info')).toBe(true);
    expect(shouldHideTurnRunHeader('using_tools', 'neutral')).toBe(true);
    expect(shouldHideTurnRunHeader('waiting_tool', 'neutral')).toBe(true);
  });

  it('tone 为 success 时无论 key 是什么都隐藏', () => {
    expect(shouldHideTurnRunHeader('cancelled', 'success')).toBe(true);
  });

  it('异常/终态 key（blocked/cancelled/resumable/stale_stream）保留显示', () => {
    expect(shouldHideTurnRunHeader('blocked', 'error')).toBe(false);
    expect(shouldHideTurnRunHeader('cancelled', 'warning')).toBe(false);
    expect(shouldHideTurnRunHeader('resumable', 'warning')).toBe(false);
    expect(shouldHideTurnRunHeader('stale_stream', 'neutral')).toBe(false);
  });
});

describe('TurnCard — 顶部状态条走 i18n 人话文案,不直出枚举字面量（zh 默认语言）', () => {
  it('cancelling 状态显示"正在停止"，工具计数走 {count} 次工具调用', () => {
    const turn = makeStreamingTurnWithTools();
    const html = renderToStaticMarkup(
      React.createElement(TurnCard, { turn, sessionStatus: 'cancelling', defaultExpanded: true }),
    );

    expect(html).toContain('正在停止');
    expect(html).toContain('2 次工具调用');
    // 旧实现把状态机字面量原样当文案：'cancelling' 不应作为可见文本出现
    expect(html).not.toMatch(/>cancelling</);
  });
});
