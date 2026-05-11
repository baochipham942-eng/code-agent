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
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

describe('TurnCard hook activity', () => {
  it('shows hook execution summary as a visible turn banner', () => {
    const turn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'completed',
      startTime: 100,
      endTime: 220,
      nodes: [
        {
          id: 'user-1',
          type: 'user',
          content: '你是谁',
          timestamp: 100,
        },
        {
          id: 'turn-1-hook-activity',
          type: 'turn_timeline',
          content: '',
          timestamp: 120,
          turnTimeline: {
            id: 'turn-1-hook-activity',
            kind: 'hook_activity',
            timestamp: 120,
            tone: 'success',
            hookActivity: {
              summary: '命中 2 个 hook · 已放行 · 12ms',
              items: [
                {
                  timestamp: 110,
                  event: 'UserPromptSubmit',
                  action: 'allow',
                  hookCount: 1,
                  durationMs: 4,
                },
                {
                  timestamp: 120,
                  event: 'SessionStart',
                  action: 'allow',
                  hookCount: 1,
                  durationMs: 8,
                },
              ],
            },
          },
        },
        {
          id: 'assistant-1',
          type: 'assistant_text',
          content: '我是艾克斯。',
          timestamp: 220,
        },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn }));

    expect(html).toContain('执行了 2 个钩子');
    expect(html).toContain('用户提示提交');
    expect(html).toContain('会话开始');
    expect(html).toContain('钩子');
    expect(html).not.toContain('已放行');
  });
});
