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

function makeTurn(withNeoTag: boolean): TraceTurn {
  return {
    turnNumber: 1,
    turnId: withNeoTag ? 'neo-source-1' : 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 200,
    nodes: [
      {
        id: 'user-1',
        type: 'user',
        content: withNeoTag ? '@neo 查个数据' : '查个数据',
        timestamp: 100,
        metadata: withNeoTag
          ? {
              neoTag: {
                workCardId: 'nwc_1',
                sourceConversationId: 'conv_1',
                sourceTurnId: 'neo-source-1',
              },
            }
          : undefined,
      },
      {
        id: 'assistant-1-text',
        type: 'assistant_text',
        content: '这是回复',
        timestamp: 150,
      },
    ],
  };
}

describe('TurnCard Neo participant identity (@neo tag 回复身份标识)', () => {
  it('marks the reply of a @neo-triggered turn with a lightweight Neo participant badge', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turn: makeTurn(true),
      sessionStatus: 'idle',
    }));

    expect(html).toContain('data-testid="neo-turn-identity"');
    expect(html).toContain('Neo');
  });

  it('does not add the badge to ordinary turns', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, {
      turn: makeTurn(false),
      sessionStatus: 'idle',
    }));

    expect(html).not.toContain('data-testid="neo-turn-identity"');
  });
});
