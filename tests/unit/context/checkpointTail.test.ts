import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { selectCheckpointTail } from '../../../src/main/context/checkpoint';

function msg(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Date.now() };
}

describe('checkpoint tail selection', () => {
  it('starts near the last assistant turn and preserves recent tail messages', () => {
    const messages = [
      msg('u1', 'user', 'old request'),
      msg('a1', 'assistant', 'old work'),
      msg('u2', 'user', 'recent request'),
      msg('a2', 'assistant', 'recent answer'),
      msg('u3', 'user', 'next'),
    ];

    const tail = selectCheckpointTail(messages, {
      minTokens: 1,
      maxTokens: 1000,
      minTextMessages: 1,
    });

    expect(tail.boundaryMessageId).toBe('u2');
    expect(tail.preservedMessages.map((message) => message.id)).toEqual(['u2', 'a2', 'u3']);
    expect(tail.compactedMessages.map((message) => message.id)).toEqual(['u1', 'a1']);
  });

  it('expands backward when the natural tail is below the text-message floor', () => {
    const messages = [
      msg('u1', 'user', 'one'),
      msg('a1', 'assistant', 'two'),
      msg('u2', 'user', 'three'),
      msg('a2', 'assistant', 'four'),
    ];

    const tail = selectCheckpointTail(messages, {
      minTokens: 1,
      maxTokens: 1000,
      minTextMessages: 4,
    });

    expect(tail.boundaryMessageId).toBe('u1');
    expect(tail.compactedMessages).toEqual([]);
  });
});

