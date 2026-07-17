import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { en } from '../../../src/renderer/i18n/en';

// 同一套键（zh/en 相邻维护），不为顶部状态条另建第二套词表——见 turnCard.runStatus.test.ts 的 zh 态。
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

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

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

describe('TurnCard — 顶部状态条 en 态接线（不中英混排）', () => {
  it('cancelling 状态显示 Stopping…，工具计数走 {count} tool calls', () => {
    const turn: TraceTurn = {
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

    const html = renderToStaticMarkup(
      React.createElement(TurnCard, { turn, sessionStatus: 'cancelling', defaultExpanded: true }),
    );

    expect(html).toContain('Stopping');
    expect(html).toContain('2 tool calls');
    expect(html).not.toContain('正在停止');
  });
});
