import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { applyStreamingMessageDeltasToProjection } from '../../../src/renderer/utils/streamingProjectionOverlay';

describe('applyStreamingMessageDeltasToProjection', () => {
  it('overlays accumulator deltas onto an existing assistant text node', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'streaming',
          startTime: 100,
          nodes: [
            { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
            { id: 'assistant-1-text', type: 'assistant_text', content: 'hello', timestamp: 120, reasoning: 'r1' },
          ],
        },
      ],
    };

    const next = applyStreamingMessageDeltasToProjection(
      projection,
      [],
      {
        'assistant-1': {
          contentDelta: ' world',
          reasoningDelta: 'r2',
          updatedAt: 200,
        },
      },
    );

    expect(next.turns[0].nodes[1]).toMatchObject({
      content: 'hello world',
      reasoning: 'r1r2',
    });
    expect(next).not.toBe(projection);
  });

  it('synthesizes an assistant text node for an empty base assistant message', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'question', timestamp: 100 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 120, toolCalls: [] },
    ];
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'streaming',
          startTime: 100,
          nodes: [
            { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
          ],
        },
      ],
    };

    const next = applyStreamingMessageDeltasToProjection(
      projection,
      messages,
      {
        'assistant-1': {
          contentDelta: 'streamed answer',
          reasoningDelta: '',
          updatedAt: 200,
        },
      },
    );

    expect(next.turns[0].nodes).toHaveLength(2);
    expect(next.turns[0].nodes[1]).toMatchObject({
      id: 'assistant-1-text',
      type: 'assistant_text',
      content: 'streamed answer',
    });
  });

  it('returns the original projection when there are no active deltas', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [],
    };

    expect(applyStreamingMessageDeltasToProjection(projection, [], {})).toBe(projection);
  });
});

describe('reasoningDelta 尾置（2026-07-21 闪烁修复）', () => {
  const baseTurnWithTrailingTool = (): TraceProjection => ({
    sessionId: 'session-1',
    activeTurnIndex: 0,
    turns: [
      {
        turnNumber: 1,
        turnId: 'turn-1',
        status: 'streaming',
        startTime: 100,
        nodes: [
          { id: 'user-1', type: 'user', content: 'q', timestamp: 100 },
          { id: 'assistant-1-text', messageId: 'assistant-1', type: 'assistant_text', content: 'partial', timestamp: 120 },
          { id: 'assistant-1-tc-1', type: 'tool_call', content: '', timestamp: 130, toolCall: { id: 'tc-1', name: 'Read', args: {} } },
        ],
      },
    ],
  });

  it('首文本节点身后有工具节点：reasoningDelta 建轮尾 live 节点，不撑大首节点', () => {
    const next = applyStreamingMessageDeltasToProjection(
      baseTurnWithTrailingTool(),
      [],
      { 'assistant-1': { contentDelta: '', reasoningDelta: 'new thought', updatedAt: 200 } },
    );
    const nodes = next.turns[0].nodes;
    const last = nodes[nodes.length - 1];
    expect(last.id).toBe('assistant-1-reasoning-live');
    expect(last.reasoning).toBe('new thought');
    const baseNode = nodes.find((n) => n.id === 'assistant-1-text');
    expect(baseNode?.content).toBe('partial');
    expect(baseNode?.reasoning).toBeUndefined();
  });

  it('已有 live 节点：reasoningDelta 原地追加', () => {
    const projection = baseTurnWithTrailingTool();
    projection.turns[0].nodes.push({
      id: 'assistant-1-reasoning-live',
      messageId: 'assistant-1',
      type: 'assistant_text',
      content: '',
      timestamp: 140,
      reasoning: 'flushed ',
    });
    const next = applyStreamingMessageDeltasToProjection(
      projection,
      [],
      { 'assistant-1': { contentDelta: '', reasoningDelta: 'streamed', updatedAt: 200 } },
    );
    const nodes = next.turns[0].nodes;
    expect(nodes[nodes.length - 1].reasoning).toBe('flushed streamed');
    expect(nodes.filter((n) => n.id === 'assistant-1-reasoning-live')).toHaveLength(1);
  });

  it('contentDelta 仍打首文本节点（本批仅治思考流）', () => {
    const next = applyStreamingMessageDeltasToProjection(
      baseTurnWithTrailingTool(),
      [],
      { 'assistant-1': { contentDelta: ' more', reasoningDelta: '', updatedAt: 200 } },
    );
    expect(next.turns[0].nodes.find((n) => n.id === 'assistant-1-text')?.content).toBe('partial more');
  });
});
