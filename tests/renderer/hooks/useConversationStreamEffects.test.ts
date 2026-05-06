import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  applyConversationStreamEvent,
  removeUncommittedAssistantDraft,
} from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';

describe('removeUncommittedAssistantDraft', () => {
  it('removes a streamed assistant draft that was never committed by a message event', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'run validation',
        timestamp: 100,
      },
      {
        id: 'turn-draft-1',
        role: 'assistant',
        content: 'draft answer that validation rejected',
        timestamp: 120,
      },
    ];

    expect(removeUncommittedAssistantDraft(messages, 'turn-draft-1')).toEqual([
      messages[0],
    ]);
  });

  it('keeps committed tool turns because later iterations need their trace', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'read file',
        timestamp: 100,
      },
      {
        id: 'turn-tool-1',
        role: 'assistant',
        content: 'I will read it.',
        timestamp: 120,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'Read',
            arguments: { path: '/tmp/large.txt' },
          },
        ],
      },
    ];

    expect(removeUncommittedAssistantDraft(messages, 'turn-tool-1')).toBe(messages);
  });

  it('does not touch unrelated or non-assistant messages', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 100,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        timestamp: 120,
      },
    ];

    expect(removeUncommittedAssistantDraft(messages, 'missing')).toBe(messages);
    expect(removeUncommittedAssistantDraft(messages, 'user-1')).toBe(messages);
    expect(removeUncommittedAssistantDraft(messages, null)).toBe(messages);
  });

  it('drops the previous streamed draft when a new turn starts without any committed assistant message', () => {
    let messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'first prompt',
        timestamp: 100,
      },
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'draft that should disappear',
        timestamp: 120,
        toolCalls: [],
      },
    ];

    const state = {
      currentTurnMessageId: 'turn-1',
      committedAssistantMessageIds: new Set<string>(),
    };

    applyConversationStreamEvent(
      {
        type: 'turn_start',
        data: { turnId: 'turn-2', iteration: 2 },
      },
      state,
      {
        addMessage: (message) => {
          messages = [...messages, message];
        },
        updateMessage: () => {},
        setMessages: (nextMessages) => {
          messages = nextMessages;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
        now: () => 200,
        generateId: () => 'generated-turn',
      },
    );

    expect(messages).toEqual([
      {
        id: 'user-1',
        role: 'user',
        content: 'first prompt',
        timestamp: 100,
      },
      {
        id: 'turn-2',
        role: 'assistant',
        content: '',
        timestamp: 200,
        toolCalls: [],
      },
    ]);
    expect(state.currentTurnMessageId).toBe('turn-2');
  });
});
