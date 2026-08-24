import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompressionState } from '../../../../src/host/context/compressionState';
import { applyContextCollapse } from '../../../../src/host/context/layers/contextCollapse';
import { ProjectionEngine, type ProjectableMessage } from '../../../../src/host/context/projectionEngine';

function collapsibleMessages() {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `tool-${index + 1}`,
    role: 'tool',
    content: 'large tool output '.repeat(100),
    turnIndex: index,
  }));
}

describe('applyContextCollapse summary admission', () => {
  let state: CompressionState;

  beforeEach(() => {
    state = new CompressionState();
  });

  it('does not commit a whitespace-only summary', async () => {
    const summarize = vi.fn().mockResolvedValue(' \n\t ');

    await applyContextCollapse(collapsibleMessages(), state, {
      minSpanSize: 3,
      maxSummaryTokens: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(state.getCommitLog()).toHaveLength(0);
    expect(state.getSnapshot().collapsedSpans).toHaveLength(0);
  });

  it('does not commit a summary over maxSummaryTokens', async () => {
    const summarize = vi.fn().mockResolvedValue('oversized summary '.repeat(20));

    await applyContextCollapse(collapsibleMessages(), state, {
      minSpanSize: 3,
      maxSummaryTokens: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(state.getCommitLog()).toHaveLength(0);
    expect(state.getSnapshot().collapsedSpans).toHaveLength(0);
  });

  it('collapses a parallel tool round atomically without leaving orphan calls', async () => {
    const largeOutput = 'parallel tool output '.repeat(1_000);
    const messages = [
      { id: 'm0', role: 'user', content: 'start', turnIndex: 0 },
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        turnIndex: 1,
        toolCalls: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      },
      { id: 'm2', role: 'tool', content: largeOutput, turnIndex: 2, toolCallId: 'c1' },
      { id: 'm3', role: 'tool', content: largeOutput, turnIndex: 3, toolCallId: 'c2' },
      { id: 'm4', role: 'tool', content: largeOutput, turnIndex: 4, toolCallId: 'c3' },
      { id: 'm5', role: 'user', content: 'next', turnIndex: 5 },
    ];

    await applyContextCollapse(messages, state, {
      minSpanSize: 3,
      maxSummaryTokens: 200,
      summarize: async () => 'parallel tool round summarized',
    });

    expect(state.getSnapshot().collapsedSpans.map((span) => span.messageIds)).toEqual([
      ['m1', 'm2', 'm3', 'm4'],
    ]);

    const projected = new ProjectionEngine().projectMessages(messages, state);
    const callIds = projected.flatMap((message) => (
      Array.isArray(message.toolCalls)
        ? (message.toolCalls as Array<{ id: string }>).map((call) => call.id)
        : []
    ));
    const resultIds = projected
      .filter((message) => message.role === 'tool' && typeof message.toolCallId === 'string')
      .map((message) => message.toolCallId as string);

    expect(projected.map((message) => `${message.id}:${message.role}`)).toEqual([
      'm0:user',
      'm1:system',
      'm5:user',
    ]);
    expect(callIds.filter((id) => !resultIds.includes(id))).toEqual([]);
    expect(resultIds.filter((id) => !callIds.includes(id))).toEqual([]);
    expect(projected[1]).not.toHaveProperty('toolCalls');
    expect(projected[1]).not.toHaveProperty('toolCallId');
  });

  it('still collapses a long span of standalone tool outputs', async () => {
    const messages = collapsibleMessages();

    await applyContextCollapse(messages, state, {
      minSpanSize: 3,
      maxSummaryTokens: 20,
      summarize: async () => 'standalone outputs summarized',
    });

    expect(state.getSnapshot().collapsedSpans.map((span) => span.messageIds)).toEqual([
      ['tool-1', 'tool-2', 'tool-3'],
    ]);
    const projected = new ProjectionEngine().projectMessages(
      messages as ProjectableMessage[],
      state,
    );
    expect(projected).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        role: 'system',
        content: '[collapsed: 3 turns] standalone outputs summarized',
      }),
    ]);
  });
});
