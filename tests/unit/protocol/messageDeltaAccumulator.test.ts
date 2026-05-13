import { describe, expect, it } from 'vitest';
import { MessageDeltaAccumulator } from '../../../src/main/protocol/messageDeltaAccumulator';

describe('MessageDeltaAccumulator', () => {
  it('accumulates assistant content and reasoning deltas per session', () => {
    const accumulator = new MessageDeltaAccumulator();

    accumulator.apply('session-1', {
      type: 'turn_start',
      data: { turnId: 'turn-1' },
    });
    accumulator.apply('session-1', {
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
    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'reasoning',
        op: 'append',
        text: 'thinking',
        turnId: 'turn-1',
      },
    });
    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'world',
        turnId: 'turn-1',
      },
    });

    expect(accumulator.getSnapshot('session-1', true)).toMatchObject({
      role: 'assistant',
      turnId: 'turn-1',
      messageId: 'turn-1',
      content: 'hello world',
      reasoning: 'thinking',
      isFinal: true,
      source: 'main_accumulator',
    });
  });

  it('keeps sessions isolated and clears only the requested session', () => {
    const accumulator = new MessageDeltaAccumulator();

    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'one',
      },
    });
    accumulator.apply('session-2', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'two',
      },
    });

    accumulator.clear('session-1');

    expect(accumulator.getSnapshot('session-1')).toBeNull();
    expect(accumulator.getSnapshot('session-2')).toMatchObject({
      content: 'two',
    });
  });

  it('drops duplicate or out-of-order message deltas when deltaSeq is present', () => {
    const accumulator = new MessageDeltaAccumulator();

    accumulator.apply('session-1', {
      type: 'turn_start',
      data: { turnId: 'turn-1' },
    });
    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'hello ',
        turnId: 'turn-1',
        deltaSeq: 1,
      },
    });
    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'hello ',
        turnId: 'turn-1',
        deltaSeq: 1,
      },
    });
    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'stale',
        turnId: 'turn-1',
        deltaSeq: 0,
      },
    });
    accumulator.apply('session-1', {
      type: 'message_delta',
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: 'world',
        turnId: 'turn-1',
        deltaSeq: 2,
      },
    });

    expect(accumulator.getSnapshot('session-1', true)).toMatchObject({
      content: 'hello world',
    });
  });
});
