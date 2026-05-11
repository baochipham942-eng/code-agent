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

describe('TurnCard skill activity', () => {
  it('shows skill trigger and context write summary as a visible turn banner', () => {
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
          content: '用飞书文档 skill',
          timestamp: 100,
        },
        {
          id: 'turn-1-skill-activity',
          type: 'turn_timeline',
          content: '',
          timestamp: 120,
          turnTimeline: {
            id: 'turn-1-skill-activity',
            kind: 'skill_activity',
            timestamp: 120,
            tone: 'success',
            skillActivity: {
              summary: 'Skill 触发 1 · 写入 1',
              items: [
                {
                  timestamp: 120,
                  skillId: 'lark-doc',
                  label: 'lark-doc',
                  action: 'triggered',
                  detail: 'inline skill tool',
                  source: 'user',
                },
                {
                  timestamp: 121,
                  skillId: 'lark-doc',
                  label: 'lark-doc',
                  action: 'written',
                  detail: 'Skill 指令已写入模型上下文',
                  source: 'user',
                },
              ],
            },
          },
        },
        {
          id: 'skill-status-1',
          type: 'system',
          content: '<command-message>Loading skill: lark-doc</command-message><command-name>lark-doc</command-name>',
          timestamp: 130,
          subtype: 'skill_status',
        },
        {
          id: 'assistant-1',
          type: 'assistant_text',
          content: '继续。',
          timestamp: 220,
        },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn }));

    expect(html).toContain('Skill 触发 1 · 写入 1');
    expect(html).toContain('lark-doc');
    expect(html).toContain('已触发');
    expect(html).toContain('已写入');
    expect(html).not.toContain('command-message');
  });
});
