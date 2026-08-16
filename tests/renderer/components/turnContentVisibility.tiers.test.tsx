import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

function toolNode(): TraceNode {
  return {
    id: 'tool-node',
    type: 'tool_call',
    content: '',
    timestamp: 101,
    toolCall: { id: 'tool-1', name: 'Read', args: {}, result: 'done', success: true },
  };
}

function turn(status: TraceTurn['status'], nodes: TraceNode[]): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status,
    startTime: 100,
    endTime: status === 'completed' ? 200 : undefined,
    nodes,
  };
}

describe('turn/tool content visibility tiers', () => {
  it('defers completed tool cards and keeps active tool cards visible', () => {
    const completed = renderToStaticMarkup(<ToolStepGroup nodes={[toolNode()]} />);
    const active = renderToStaticMarkup(<ToolStepGroup nodes={[toolNode()]} isStreamingTurn />);

    expect(completed).toContain('data-deferred-content="tool-card"');
    expect(completed).toContain('contain-intrinsic-size:auto 160px');
    expect(active).not.toContain('data-deferred-content="tool-card"');
  });

  it('uses text/tool/code estimates for completed turns and never defers the active turn', () => {
    const userNode: TraceNode = { id: 'user-1', type: 'user', content: 'question', timestamp: 100 };
    const textNode: TraceNode = { id: 'assistant-1', type: 'assistant_text', content: 'answer', timestamp: 101 };
    const codeNode: TraceNode = { ...textNode, content: '```ts\nconst value = 1;\n```' };

    const textHtml = renderToStaticMarkup(<TurnCard turn={turn('completed', [userNode, textNode])} />);
    const toolHtml = renderToStaticMarkup(<TurnCard turn={turn('completed', [userNode, toolNode()])} />);
    const codeHtml = renderToStaticMarkup(<TurnCard turn={turn('completed', [userNode, codeNode])} />);
    const activeHtml = renderToStaticMarkup(
      <TurnCard turn={turn('streaming', [userNode, codeNode])} isActiveTurn />,
    );

    expect(textHtml).toContain('contain-intrinsic-size:auto 1040px');
    expect(toolHtml).toContain('contain-intrinsic-size:auto 1060px');
    expect(codeHtml).toContain('contain-intrinsic-size:auto 680px');
    expect(activeHtml).not.toContain('data-deferred-content="turn"');
    expect(activeHtml).not.toContain('data-deferred-content="code-block"');
    expect(activeHtml).not.toContain('data-deferred-content="tool-card"');
  });
});
