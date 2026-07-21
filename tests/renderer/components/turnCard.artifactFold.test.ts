import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '@shared/contract/trace';

vi.mock('@renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: TraceTurn['nodes'][number] }) => (
    React.createElement('div', null, node.turnTimeline?.kind ?? node.content)
  ),
}));

vi.mock('@renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
  getRunningToolStartTime: () => null,
}));

vi.mock('@renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('@renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '@renderer/components/features/chat/TurnCard';

describe('TurnCard artifact fold boundary', () => {
  it('keeps turn-owned outputs visible when process details are folded', () => {
    const turn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'completed',
      startTime: 1,
      endTime: 10,
      nodes: [
        { id: 'user', type: 'user', content: 'Create a report', timestamp: 1 },
        ...[2, 3, 4].map((timestamp) => ({
          id: `tool-${timestamp}`,
          type: 'tool_call' as const,
          content: '',
          timestamp,
          toolCall: { id: `call-${timestamp}`, name: 'work', args: {}, success: true },
        })),
        { id: 'final', type: 'assistant_text', content: 'Done', timestamp: 9 },
        {
          id: 'artifacts',
          type: 'turn_timeline',
          content: '',
          timestamp: 10,
          turnTimeline: {
            id: 'turn-1-artifact-ownership',
            kind: 'artifact_ownership',
            timestamp: 10,
            tone: 'success',
            artifactOwnership: [{
              kind: 'file',
              label: 'report.md',
              ownerKind: 'assistant',
              ownerLabel: 'Neo',
            }],
          },
        },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('artifact_ownership');
  });
});
