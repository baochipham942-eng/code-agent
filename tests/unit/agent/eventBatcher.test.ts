import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import { EventBatcher } from '../../../src/main/agent/eventBatcher';

describe('EventBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges consecutive stream chunks for the same turn', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush, flushInterval: 16 });

    batcher.emit({ type: 'stream_chunk', data: { content: 'hello ', turnId: 'turn-1' } });
    batcher.emit({ type: 'stream_chunk', data: { content: 'world', turnId: 'turn-1' } });
    vi.advanceTimersByTime(16);

    expect(onFlush).toHaveBeenCalledWith([
      { type: 'stream_chunk', data: { content: 'hello world', turnId: 'turn-1', parentToolUseId: undefined } },
    ]);
  });

  it('preserves renderer envelope metadata when stream chunks are merged', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush, flushInterval: 16 });

    batcher.emit({
      type: 'stream_chunk',
      data: { content: 'hello ', turnId: 'turn-1' },
      sessionId: 'session-1',
      seq: 1,
    } as AgentEvent & { sessionId: string; seq: number });
    batcher.emit({
      type: 'stream_chunk',
      data: { content: 'world', turnId: 'turn-1' },
      sessionId: 'session-1',
      seq: 2,
    } as AgentEvent & { sessionId: string; seq: number });
    vi.advanceTimersByTime(16);

    expect(onFlush).toHaveBeenCalledWith([
      {
        type: 'stream_chunk',
        data: { content: 'hello world', turnId: 'turn-1', parentToolUseId: undefined },
        sessionId: 'session-1',
        seq: 2,
      },
    ]);
  });

  it('merges consecutive message deltas for the same assistant content path', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush, flushInterval: 16 });

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

    expect(onFlush).toHaveBeenCalledWith([
      {
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'hello world',
          turnId: 'turn-1',
          messageId: 'turn-1',
          parentToolUseId: undefined,
        },
      },
    ]);
  });

  it('keeps the latest deltaSeq when message deltas are merged', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush, flushInterval: 16 });

    batcher.emit({
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'hello ',
        turnId: 'turn-1',
        messageId: 'turn-1',
        deltaSeq: 1,
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
        deltaSeq: 2,
      },
    });
    vi.advanceTimersByTime(16);

    expect(onFlush).toHaveBeenCalledWith([
      {
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'hello world',
          turnId: 'turn-1',
          messageId: 'turn-1',
          deltaSeq: 2,
          parentToolUseId: undefined,
        },
      },
    ]);
  });

  it('keeps content and reasoning message deltas separate', () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.emit({
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'reasoning',
        op: 'append',
        text: 'think',
        turnId: 'turn-1',
      },
    });
    batcher.emit({
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'answer',
        turnId: 'turn-1',
      },
    });
    batcher.flush();

    expect(onFlush).toHaveBeenCalledWith([
      {
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'reasoning',
          op: 'append',
          text: 'think',
          turnId: 'turn-1',
          messageId: undefined,
          parentToolUseId: undefined,
        },
      },
      {
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'answer',
          turnId: 'turn-1',
          messageId: undefined,
          parentToolUseId: undefined,
        },
      },
    ]);
  });

  it('keeps event order when a text delta is followed by a tool-call delta', () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.emit({ type: 'stream_chunk', data: { content: 'before tool', turnId: 'turn-1' } });
    batcher.emit({
      type: 'stream_tool_call_delta',
      data: { index: 0, argumentsDelta: '{"path":' },
    });
    batcher.flush();

    expect(onFlush).toHaveBeenCalledWith([
      { type: 'stream_chunk', data: { content: 'before tool', turnId: 'turn-1', parentToolUseId: undefined } },
      { type: 'stream_tool_call_delta', data: { index: 0, argumentsDelta: '{"path":' } },
    ]);
  });

  it('merges consecutive tool-call argument deltas for the same pending call', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush, flushInterval: 16 });

    batcher.emit({
      type: 'stream_tool_call_delta',
      data: { index: 0, name: 'Bash', argumentsDelta: '{"command":"npm ', turnId: 'turn-1' },
    });
    batcher.emit({
      type: 'stream_tool_call_delta',
      data: { index: 0, argumentsDelta: 'test"}', turnId: 'turn-1' },
    });
    vi.advanceTimersByTime(16);

    expect(onFlush).toHaveBeenCalledWith([
      {
        type: 'stream_tool_call_delta',
        data: {
          index: 0,
          name: 'Bash',
          argumentsDelta: '{"command":"npm test"}',
          turnId: 'turn-1',
        },
      },
    ]);
  });

  it('keeps separate tool-call deltas for different pending calls', () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.emit({
      type: 'stream_tool_call_delta',
      data: { index: 0, name: 'Read', argumentsDelta: '{"path":' },
    });
    batcher.emit({
      type: 'stream_tool_call_delta',
      data: { index: 1, name: 'Bash', argumentsDelta: '{"command":' },
    });
    batcher.flush();

    expect(onFlush).toHaveBeenCalledWith([
      { type: 'stream_tool_call_delta', data: { index: 0, name: 'Read', argumentsDelta: '{"path":' } },
      { type: 'stream_tool_call_delta', data: { index: 1, name: 'Bash', argumentsDelta: '{"command":' } },
    ]);
  });

  it('separates stream reasoning from visible text', () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });

    batcher.emit({ type: 'stream_reasoning', data: { content: 'think ', turnId: 'turn-1' } });
    batcher.emit({ type: 'stream_reasoning', data: { content: 'more', turnId: 'turn-1' } });
    batcher.emit({ type: 'stream_chunk', data: { content: 'answer', turnId: 'turn-1' } });
    batcher.flush();

    expect(onFlush).toHaveBeenCalledWith([
      { type: 'stream_reasoning', data: { content: 'think more', turnId: 'turn-1', parentToolUseId: undefined } },
      { type: 'stream_chunk', data: { content: 'answer', turnId: 'turn-1', parentToolUseId: undefined } },
    ]);
  });

  it('flushes pending stream text before immediate lifecycle events', () => {
    const onFlush = vi.fn();
    const batcher = new EventBatcher({ onFlush });
    const immediate: AgentEvent = { type: 'turn_end', data: { turnId: 'turn-1' } };

    batcher.emit({ type: 'stream_chunk', data: { content: 'final', turnId: 'turn-1' } });
    batcher.emit(immediate);

    expect(onFlush).toHaveBeenNthCalledWith(1, [
      { type: 'stream_chunk', data: { content: 'final', turnId: 'turn-1', parentToolUseId: undefined } },
    ]);
    expect(onFlush).toHaveBeenNthCalledWith(2, [immediate]);
  });
});
