import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  applyConversationStreamEvent,
  mergeCommittedAssistantContent,
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

describe('applyConversationStreamEvent model_decision', () => {
  it('attaches the model decision to the current assistant message', () => {
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: '',
        timestamp: 100,
      },
    ];

    applyConversationStreamEvent(
      {
        type: 'model_decision',
        data: {
          turnId: 'turn-1',
          requestedProvider: 'moonshot',
          requestedModel: 'kimi-k2.5',
          resolvedProvider: 'zhipu',
          resolvedModel: 'glm-4.5-flash',
          reason: 'simple-task-free',
          role: null,
          billingMode: 'payg',
          fallbackFrom: null,
          timestamp: 200,
        },
      },
      {
        currentTurnMessageId: 'turn-1',
        committedAssistantMessageIds: new Set<string>(),
      },
      {
        addMessage: (message) => {
          messages = [...messages, message];
        },
        updateMessage: (id, updates) => {
          messages = messages.map((message) =>
            message.id === id ? { ...message, ...updates } : message
          );
        },
        setMessages: (nextMessages) => {
          messages = nextMessages;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(messages[0].modelDecision).toMatchObject({
      requestedModel: 'kimi-k2.5',
      resolvedModel: 'glm-4.5-flash',
      reason: 'simple-task-free',
    });
  });
});

describe('applyConversationStreamEvent meta turns', () => {
  it('does not render meta loop turn starts or append their stream chunks to the previous assistant', () => {
    const appendStreamingMessageDelta = vi.fn();
    const queueUpdate = vi.fn();
    let messages: Message[] = [
      {
        id: 'assistant-visible',
        role: 'assistant',
        content: 'visible answer',
        timestamp: 100,
      },
    ];
    const state = {
      currentTurnMessageId: 'assistant-visible',
      committedAssistantMessageIds: new Set<string>(['assistant-visible']),
    };

    const actions = {
      addMessage: (message: Message) => {
        messages = [...messages, message];
      },
      appendStreamingMessageDelta,
      updateMessage: () => {},
      setMessages: (nextMessages: Message[]) => {
        messages = nextMessages;
      },
      getMessages: () => messages,
      queueUpdate,
      now: () => 200,
      generateId: () => 'generated-turn',
    };

    applyConversationStreamEvent(
      { type: 'turn_start', data: { turnId: 'turn-meta', iteration: 1, isMeta: true } },
      state,
      actions,
    );
    applyConversationStreamEvent(
      { type: 'stream_chunk', data: { turnId: 'turn-meta', content: 'hidden text', isMeta: true } },
      state,
      actions,
    );
    applyConversationStreamEvent(
      { type: 'message', data: { id: 'assistant-meta', turnId: 'turn-meta', content: 'hidden final', isMeta: true } },
      state,
      actions,
    );

    expect(messages).toEqual([
      {
        id: 'assistant-visible',
        role: 'assistant',
        content: 'visible answer',
        timestamp: 100,
      },
    ]);
    expect(state.currentTurnMessageId).toBe('turn-meta');
    expect(state.committedAssistantMessageIds.has('turn-meta')).toBe(true);
    expect(state.committedAssistantMessageIds.has('assistant-meta')).toBe(true);
    expect(appendStreamingMessageDelta).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('removes an existing assistant draft when the final message is meta', () => {
    let messages: Message[] = [
      {
        id: 'turn-meta',
        role: 'assistant',
        content: 'draft that should not remain visible',
        timestamp: 100,
      },
    ];
    const state = {
      currentTurnMessageId: 'turn-meta',
      committedAssistantMessageIds: new Set<string>(),
    };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: {
          id: 'assistant-meta',
          turnId: 'turn-meta',
          content: 'hidden final',
          isMeta: true,
        },
      },
      state,
      {
        addMessage: () => {},
        updateMessage: () => {},
        setMessages: (nextMessages) => {
          messages = nextMessages;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(messages).toEqual([]);
    expect(state.committedAssistantMessageIds.has('turn-meta')).toBe(true);
    expect(state.committedAssistantMessageIds.has('assistant-meta')).toBe(true);
  });
});

describe('mergeCommittedAssistantContent', () => {
  it('uses the committed message content to correct duplicated streamed text', () => {
    expect(
      mergeCommittedAssistantContent(
        'Google Assistant。国行版把这 Google Assistant。国行版把这',
        'Google Assistant。国行版把这',
      ),
    ).toBe('Google Assistant。国行版把这');
  });

  it('keeps streamed content when the committed event carries no content', () => {
    expect(mergeCommittedAssistantContent('streamed text', '')).toBe('streamed text');
  });

  it('updates the active assistant message with the committed final content', () => {
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'Google Assistant。国行版把这 Google Assistant。国行版把这',
        timestamp: 100,
      },
    ];
    const state = {
      currentTurnMessageId: 'turn-1',
      committedAssistantMessageIds: new Set<string>(),
    };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: {
          id: 'assistant-1',
          turnId: 'turn-1',
          content: 'Google Assistant。国行版把这',
        },
      },
      state,
      {
        addMessage: () => {},
        updateMessage: (id, updates) => {
          messages = messages.map((message) => (
            message.id === id ? { ...message, ...updates } : message
          ));
        },
        setMessages: (nextMessages) => {
          messages = nextMessages;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(messages[0]?.content).toBe('Google Assistant。国行版把这');
    expect(state.committedAssistantMessageIds.has('turn-1')).toBe(true);
    expect(state.committedAssistantMessageIds.has('assistant-1')).toBe(true);
  });
});

describe('applyConversationStreamEvent contentParts adoption', () => {
  it('adopts contentParts from the message event so tool/text order is preserved', () => {
    // Reproduces the WebSearch ordering bug: the server emits the correct
    // interleaved contentParts ([tool_call, text]) on the `message` event, but
    // the renderer used to drop it and fall back to content-above-tools.
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          { id: 'call_A', name: 'WebSearch', arguments: { query: 'latest' } },
        ],
      },
    ];
    const state = {
      currentTurnMessageId: 'turn-1',
      committedAssistantMessageIds: new Set<string>(),
    };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: {
          id: 'assistant-1',
          turnId: 'turn-1',
          content: '这是搜索后的简报。',
          toolCalls: [
            { id: 'call_A', name: 'WebSearch', arguments: { query: 'latest' } },
          ],
          contentParts: [
            { type: 'tool_call', toolCallId: 'call_A' },
            { type: 'text', text: '这是搜索后的简报。' },
          ],
        },
      },
      state,
      {
        addMessage: () => {},
        updateMessage: (id, updates) => {
          messages = messages.map((message) => (
            message.id === id ? { ...message, ...updates } : message
          ));
        },
        setMessages: (nextMessages) => {
          messages = nextMessages;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(messages[0]?.contentParts).toEqual([
      { type: 'tool_call', toolCallId: 'call_A' },
      { type: 'text', text: '这是搜索后的简报。' },
    ]);
  });

  it('does not clobber existing contentParts when the message event omits them', () => {
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'preamble',
        timestamp: 100,
        contentParts: [
          { type: 'text', text: 'preamble' },
          { type: 'tool_call', toolCallId: 'call_A' },
        ],
      },
    ];
    const state = {
      currentTurnMessageId: 'turn-1',
      committedAssistantMessageIds: new Set<string>(),
    };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: { id: 'assistant-1', turnId: 'turn-1', content: 'preamble' },
      },
      state,
      {
        addMessage: () => {},
        updateMessage: (id, updates) => {
          messages = messages.map((message) => (
            message.id === id ? { ...message, ...updates } : message
          ));
        },
        setMessages: () => {},
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(messages[0]?.contentParts).toEqual([
      { type: 'text', text: 'preamble' },
      { type: 'tool_call', toolCallId: 'call_A' },
    ]);
  });
});

describe('applyConversationStreamEvent streaming accumulator', () => {
  it('routes stream chunks to the local accumulator when available', () => {
    const appendStreamingMessageDelta = vi.fn();
    const queueUpdate = vi.fn();
    const messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: '',
        timestamp: 100,
      },
    ];

    applyConversationStreamEvent(
      {
        type: 'stream_chunk',
        data: { turnId: 'turn-1', content: 'hello' },
      },
      {
        currentTurnMessageId: 'turn-1',
        committedAssistantMessageIds: new Set<string>(),
      },
      {
        addMessage: () => {},
        appendStreamingMessageDelta,
        updateMessage: () => {},
        setMessages: () => {},
        getMessages: () => messages,
        queueUpdate,
      },
    );

    expect(appendStreamingMessageDelta).toHaveBeenCalledWith('turn-1', { content: 'hello' });
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('routes message_delta content to the local accumulator when available', () => {
    const appendStreamingMessageDelta = vi.fn();
    const queueUpdate = vi.fn();
    const messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: '',
        timestamp: 100,
      },
    ];

    applyConversationStreamEvent(
      {
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'content',
          op: 'append',
          text: 'hello',
          turnId: 'turn-1',
          messageId: 'turn-1',
        },
      },
      {
        currentTurnMessageId: 'turn-1',
        committedAssistantMessageIds: new Set<string>(),
      },
      {
        addMessage: () => {},
        appendStreamingMessageDelta,
        updateMessage: () => {},
        setMessages: () => {},
        getMessages: () => messages,
        queueUpdate,
      },
    );

    expect(appendStreamingMessageDelta).toHaveBeenCalledWith('turn-1', { content: 'hello' });
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('routes message_delta reasoning to the reasoning accumulator', () => {
    const appendStreamingMessageDelta = vi.fn();
    const messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: '',
        timestamp: 100,
      },
    ];

    applyConversationStreamEvent(
      {
        type: 'message_delta',
        data: {
          role: 'assistant',
          path: 'reasoning',
          op: 'append',
          text: 'thinking',
          turnId: 'turn-1',
        },
      },
      {
        currentTurnMessageId: 'turn-1',
        committedAssistantMessageIds: new Set<string>(),
      },
      {
        addMessage: () => {},
        appendStreamingMessageDelta,
        updateMessage: () => {},
        setMessages: () => {},
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(appendStreamingMessageDelta).toHaveBeenCalledWith('turn-1', { reasoning: 'thinking' });
  });

  it('uses message_snapshot to replace the active assistant draft', () => {
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'partial',
        reasoning: 'old',
        timestamp: 100,
      },
    ];

    applyConversationStreamEvent(
      {
        type: 'message_snapshot',
        data: {
          role: 'assistant',
          turnId: 'turn-1',
          messageId: 'assistant-final-1',
          content: 'authoritative text',
          reasoning: 'authoritative reasoning',
          isFinal: true,
          source: 'main_accumulator',
        },
      },
      {
        currentTurnMessageId: 'turn-1',
        committedAssistantMessageIds: new Set<string>(),
      },
      {
        addMessage: () => {},
        updateMessage: (id, updates) => {
          messages = messages.map((message) => (
            message.id === id ? { ...message, ...updates } : message
          ));
        },
        setMessages: () => {},
        getMessages: () => messages,
        queueUpdate: () => {},
      },
    );

    expect(messages[0]).toMatchObject({
      content: 'authoritative text',
      reasoning: 'authoritative reasoning',
    });
  });
});
