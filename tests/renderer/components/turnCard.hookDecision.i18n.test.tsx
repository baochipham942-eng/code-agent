// ============================================================================
// TurnCard Hooks banner — en 态接线（决策原因/状态徽章/running 不中英混排）
// zh 态断言见 turnCard.hookDecision.test.tsx；这里只验证同一套键的 en 文案。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { en } from '../../../src/renderer/i18n/en';

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

function turnWithHookActivity(hookActivity: import('../../../src/shared/contract/turnTimeline').TurnHookActivity): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 220,
    nodes: [
      { id: 'user-1', type: 'user', content: 'run it', timestamp: 100 },
      {
        id: 'turn-1-hook-activity',
        type: 'turn_timeline',
        content: '',
        timestamp: 120,
        turnTimeline: {
          id: 'turn-1-hook-activity',
          kind: 'hook_activity',
          timestamp: 120,
          tone: 'warning',
          hookActivity,
        },
      },
      { id: 'assistant-1', type: 'assistant_text', content: 'Done.', timestamp: 220 },
    ],
  };
}

describe('TurnCard Hooks banner — en 态', () => {
  it('单条拦截：折叠行徽章为 Blocked 1× · Reason: …', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: 'PreToolUse · gate',
        items: [
          {
            timestamp: 110,
            event: 'PreToolUse',
            action: 'block',
            hookCount: 1,
            durationMs: 4,
            sources: ['project'],
            hookType: 'decision',
            names: ['gate'],
            reason: 'dangerous command',
          },
        ],
      }),
    }));

    expect(html).toContain('Blocked 1×');
    expect(html).toContain('Reason: dangerous command');
    expect(html).not.toContain('拦下');
  });

  it('running 态：Running {event}…', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turn: turnWithHookActivity({
        summary: '',
        items: [],
        running: { event: 'PreToolUse' },
      }),
    }));

    expect(html).toContain('Running');
    expect(html).not.toContain('正在运行');
  });
});
