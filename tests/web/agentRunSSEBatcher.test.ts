import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachSessionIdToAgentEventData,
  createAgentRunSSEBatcher,
  resetAgentRunSSESequencesForTests,
} from '../../src/web/helpers/agentRunSSEBatcher';

describe('agentRunSSEBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAgentRunSSESequencesForTests();
  });

  it('preserves the existing sessionId payload shape', () => {
    expect(attachSessionIdToAgentEventData({ content: 'hi' }, 'session-1')).toEqual({
      content: 'hi',
      sessionId: 'session-1',
    });
    expect(attachSessionIdToAgentEventData({ content: 'hi' }, 'session-1', 7)).toEqual({
      content: 'hi',
      sessionId: 'session-1',
      seq: 7,
    });
    expect(attachSessionIdToAgentEventData([{ id: 'todo-1' }], 'session-1')).toEqual({
      items: [{ id: 'todo-1' }],
      sessionId: 'session-1',
    });
    expect(attachSessionIdToAgentEventData(null, 'session-1')).toEqual({
      sessionId: 'session-1',
    });
  });

  it('coalesces direct /api/run stream chunks before writing SSE events', () => {
    vi.useFakeTimers();
    const writeEvent = vi.fn();
    const batcher = createAgentRunSSEBatcher(writeEvent, 'session-1');

    batcher.emit({ type: 'stream_chunk', data: { content: 'hello ', turnId: 'turn-1' } });
    batcher.emit({ type: 'stream_chunk', data: { content: 'world', turnId: 'turn-1' } });
    vi.advanceTimersByTime(16);

    expect(writeEvent).toHaveBeenCalledWith('stream_chunk', {
      content: 'hello world',
      turnId: 'turn-1',
      parentToolUseId: undefined,
      sessionId: 'session-1',
      seq: 1,
    });
  });

  it('coalesces direct /api/run message deltas before writing SSE events', () => {
    vi.useFakeTimers();
    const writeEvent = vi.fn();
    const batcher = createAgentRunSSEBatcher(writeEvent, 'session-1');

    batcher.emit({
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'hello ',
        turnId: 'turn-1',
        messageId: 'turn-1',
      },
    });
    batcher.emit({
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'world',
        turnId: 'turn-1',
        messageId: 'turn-1',
      },
    });
    vi.advanceTimersByTime(16);

    expect(writeEvent).toHaveBeenCalledWith('message_delta', {
      role: 'assistant',
      path: 'content',
      op: 'append',
      text: 'hello world',
      turnId: 'turn-1',
      messageId: 'turn-1',
      parentToolUseId: undefined,
      sessionId: 'session-1',
      seq: 1,
    });
  });

  it('flushes pending text before immediate completion', () => {
    const writeEvent = vi.fn();
    const batcher = createAgentRunSSEBatcher(writeEvent, 'session-1');

    batcher.emit({ type: 'stream_chunk', data: { content: 'done', turnId: 'turn-1' } });
    batcher.emit({ type: 'agent_complete', data: null });

    expect(writeEvent).toHaveBeenNthCalledWith(1, 'stream_chunk', {
      content: 'done',
      turnId: 'turn-1',
      parentToolUseId: undefined,
      sessionId: 'session-1',
      seq: 1,
    });
    expect(writeEvent).toHaveBeenNthCalledWith(2, 'agent_complete', {
      sessionId: 'session-1',
      seq: 2,
    });
  });
});
