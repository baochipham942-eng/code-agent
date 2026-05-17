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

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

describe('TurnCard hook activity', () => {
  it('hides normal tool execution status around the command list', () => {
    const turn: TraceTurn = {
      turnNumber: 2,
      turnId: 'turn-2',
      status: 'streaming',
      startTime: 200,
      nodes: [
        {
          id: 'user-2',
          type: 'user',
          content: '继续查一下',
          timestamp: 200,
        },
        {
          id: 'assistant-2-tc-tool-1',
          type: 'tool_call',
          content: '',
          timestamp: 240,
          toolCall: {
            id: 'tool-1',
            name: 'Read',
            args: {},
          },
        },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turn,
      isActiveTurn: true,
      sessionStatus: 'running',
    }));

    expect(html).toContain('继续查一下');
    expect(html).toContain('tool group');
    expect(html).not.toContain('using_tools');
    expect(html).not.toContain('waiting_tool');
    expect(html).not.toContain('正在使用工具');
    expect(html).not.toContain('工具调用已开始');
    expect(html).not.toContain('text-amber-300');
    expect(html).not.toContain('bg-amber-500/10');
  });

  it('shows hook execution summary as a collapsed turn banner by default', () => {
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
                  sources: ['global'],
                  hookType: 'observer',
                },
                {
                  timestamp: 120,
                  event: 'SessionStart',
                  action: 'allow',
                  hookCount: 1,
                  durationMs: 8,
                  sources: ['project'],
                  hookType: 'decision',
                  matcher: 'Bash',
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
    expect(html).toContain('全局+项目');
    expect(html).toContain('决策');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('用户提示提交');
    expect(html).not.toContain('会话开始');
    expect(html).not.toContain('已放行');
  });
});
