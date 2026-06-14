import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  applyConversationStreamEvent,
  mergeCommittedAssistantContent,
  removeUncommittedAssistantDraft,
} from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { parseModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

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
          strategySummary: '识别为简单任务，按量计费下切到快模型降低成本和延迟。',
          taskClass: 'simple',
          complexityScore: 0.12,
          costPolicy: 'save-cost',
          speedPolicy: 'provider-degraded',
          toolPolicy: 'runtime-checked',
          toolStrategy: {
            visibleToolCount: 3,
            toolNamesPreview: ['Read', 'Edit'],
            mcpToolCount: 0,
            programmaticToolCalling: 'available',
            programmaticToolCount: 3,
            tokenSavings: {
              status: 'estimated',
              savedTokens: 64,
              detail: '估算值，真实账单以 provider usage 为准。',
              basis: {
                source: 'tool-spec-local-estimate',
                toolCount: 3,
                previewToolCount: 2,
                fields: ['name', 'description', 'inputSchema'],
              },
              providerUsage: {
                source: 'model-response-usage',
                inputTokens: 300,
                outputTokens: 45,
                totalTokens: 345,
              },
            },
          },
          capabilityNeeds: ['code', 'search'],
	          providerHealthSnapshot: {
	            provider: 'zhipu',
	            status: 'degraded',
	            sampledAt: 201,
	            latencyP50: 120,
	            latencyP95: 300,
	            errorRate: 0.1,
	            consecutiveErrors: 2,
	          },
	          providerIdentity: {
	            provider: 'zhipu',
	            displayName: 'Zhipu Relay',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://relay.example.com/zhipu/v1',
	          },
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
      strategySummary: '识别为简单任务，按量计费下切到快模型降低成本和延迟。',
      taskClass: 'simple',
      complexityScore: 0.12,
      costPolicy: 'save-cost',
      speedPolicy: 'provider-degraded',
      toolPolicy: 'runtime-checked',
      toolStrategy: {
        visibleToolCount: 3,
        mcpToolCount: 0,
        programmaticToolCalling: 'available',
        programmaticToolCount: 3,
        tokenSavings: {
          status: 'estimated',
          savedTokens: 64,
          providerUsage: {
            source: 'model-response-usage',
            inputTokens: 300,
            outputTokens: 45,
            totalTokens: 345,
          },
        },
      },
      capabilityNeeds: ['code', 'search'],
	      providerHealthSnapshot: {
	        provider: 'zhipu',
	        status: 'degraded',
	        sampledAt: 201,
	        latencyP50: 120,
	        latencyP95: 300,
	        errorRate: 0.1,
	        consecutiveErrors: 2,
	      },
	      providerIdentity: {
	        provider: 'zhipu',
	        displayName: 'Zhipu Relay',
	        protocol: 'openai',
	        transportLabel: 'OpenAI-compatible',
	        endpoint: 'https://relay.example.com/zhipu/v1',
	      },
	    });
  });

  it('preserves external engine diagnostics on model decisions', () => {
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
          requestedProvider: 'claude_code',
          requestedModel: 'sonnet',
          resolvedProvider: 'claude_code',
          resolvedModel: 'sonnet',
          reason: 'user-selected',
          role: null,
          billingMode: 'unknown',
          fallbackFrom: null,
          strategySummary: 'Claude Code 使用 sonnet 执行本轮任务；CLI、登录态、quota、stream 和工具链路会影响输出可靠性。',
          taskClass: 'coding',
          costPolicy: 'user-locked',
          speedPolicy: 'normal',
          toolPolicy: 'runtime-checked',
          externalEngine: {
            kind: 'claude_code',
            label: 'Claude Code',
            model: 'sonnet',
            installState: 'installed',
            runtimeState: 'ready',
            executable: true,
            capabilities: ['execute', 'stream_events'],
            version: '2.1.177',
            reliability: {
              cliStatus: 'available',
              authState: 'not_checked',
              quotaState: 'not_checked',
              streamingMode: 'stream_json',
              toolSupport: 'read_only_cli_tools',
              transcriptMode: 'clean_stream_json',
              partialMessages: true,
              mcpBridge: false,
            },
            failure: {
              category: 'auth',
              reason: 'auth_failed',
              message: 'Failed to authenticate',
              suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
              retryable: false,
              occurredAt: 60_000,
              statusCode: 401,
              exitCode: 1,
              reliability: { authState: 'needs_login' },
            },
          },
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

    expect(messages[0].modelDecision?.externalEngine).toMatchObject({
      kind: 'claude_code',
      label: 'Claude Code',
      model: 'sonnet',
      installState: 'installed',
      runtimeState: 'ready',
      executable: true,
      capabilities: ['execute', 'stream_events'],
      version: '2.1.177',
      reliability: {
        cliStatus: 'available',
        authState: 'not_checked',
        quotaState: 'not_checked',
        streamingMode: 'stream_json',
        toolSupport: 'read_only_cli_tools',
        transcriptMode: 'clean_stream_json',
        partialMessages: true,
        mcpBridge: false,
      },
      failure: {
        category: 'auth',
        reason: 'auth_failed',
        suggestion: 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。',
        retryable: false,
        occurredAt: 60_000,
        statusCode: 401,
        exitCode: 1,
        reliability: { authState: 'needs_login' },
      },
    });
  });
});

describe('applyConversationStreamEvent model_fallback', () => {
  it('adds a model fallback notice with tried and skipped trace steps', () => {
    let messages: Message[] = [];

    applyConversationStreamEvent(
      {
        type: 'model_fallback',
        data: {
          reason: 'Xiaomi API error: 402 - insufficient balance',
          category: 'quota',
          strategy: 'adaptive-provider-fallback',
          from: 'xiaomi/mimo-v2.5-pro',
          to: 'deepseek/deepseek-v4-flash',
          fromIdentity: {
            provider: 'xiaomi',
            displayName: 'MiMo Relay',
            protocol: 'openai',
            transportLabel: 'OpenAI-compatible',
            endpoint: 'https://relay.example.com/xiaomi/v1',
          },
          toIdentity: {
            provider: 'deepseek',
            displayName: 'DeepSeek Direct',
            protocol: 'openai',
            transportLabel: 'OpenAI-compatible',
            endpoint: 'https://api.deepseek.com/v1',
          },
          tried: [
            {
              provider: 'xiaomi',
              model: 'mimo-v2.5-pro',
              providerIdentity: {
                provider: 'xiaomi',
                displayName: 'MiMo Relay',
                protocol: 'openai',
                transportLabel: 'OpenAI-compatible',
                endpoint: 'https://relay.example.com/xiaomi/v1',
              },
              status: 'tried',
              reason: 'primary_failed',
              category: 'quota',
            },
            {
              provider: 'zhipu',
              model: 'glm-4.7-flash',
              status: 'tried',
              reason: 'fallback_failed',
              category: 'network',
            },
            {
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
              status: 'selected',
              reason: 'fallback_selected',
              category: 'quota',
            },
          ],
          skipped: [
            {
              provider: 'openai',
              model: 'gpt-5.4-mini',
              status: 'skipped',
              reason: 'missing_api_key',
              category: 'quota',
            },
          ],
          toolPolicy: {
            status: 'disabled',
            reason: 'fallback_model_without_tool_support',
            originalToolCount: 3,
            effectiveToolCount: 0,
            disabledToolNames: ['Read', 'Edit', 'Bash'],
            detail: 'Fallback model does not support tool calls.',
          },
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
        updateMessage: () => {},
        setMessages: (nextMessages) => {
          messages = nextMessages;
        },
        getMessages: () => messages,
        queueUpdate: () => {},
        now: () => 250,
        generateId: () => 'fallback-message-1',
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'system',
      source: 'model',
    });
    expect(typeof messages[0].id).toBe('string');
    expect(typeof messages[0].timestamp).toBe('number');
    const notice = parseModelFallbackNotice(messages[0].content);
    expect(notice).toMatchObject({
      category: 'quota',
	      strategy: 'adaptive-provider-fallback',
	      from: 'xiaomi/mimo-v2.5-pro',
	      to: 'deepseek/deepseek-v4-flash',
	      tried: [
	        {
	          provider: 'xiaomi',
	          status: 'tried',
	          reason: 'primary_failed',
	          providerIdentity: {
	            provider: 'xiaomi',
	            displayName: 'MiMo Relay',
	            protocol: 'openai',
	            transportLabel: 'OpenAI-compatible',
	            endpoint: 'https://relay.example.com/xiaomi/v1',
	          },
	        },
	        { provider: 'zhipu', status: 'tried', reason: 'fallback_failed' },
	        { provider: 'deepseek', status: 'selected', reason: 'fallback_selected' },
	      ],
	      skipped: [
	        { provider: 'openai', status: 'skipped', reason: 'missing_api_key' },
	      ],
	      fromIdentity: {
	        provider: 'xiaomi',
	        displayName: 'MiMo Relay',
	        protocol: 'openai',
	        transportLabel: 'OpenAI-compatible',
	        endpoint: 'https://relay.example.com/xiaomi/v1',
	      },
	      toIdentity: {
	        provider: 'deepseek',
	        displayName: 'DeepSeek Direct',
	        protocol: 'openai',
	        transportLabel: 'OpenAI-compatible',
	        endpoint: 'https://api.deepseek.com/v1',
	      },
	      toolPolicy: {
	        status: 'disabled',
        reason: 'fallback_model_without_tool_support',
        originalToolCount: 3,
        effectiveToolCount: 0,
        disabledToolNames: ['Read', 'Edit', 'Bash'],
      },
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

  it('merges enriched model decision from the committed message event', () => {
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'draft',
        timestamp: 100,
        modelDecision: {
          requestedProvider: 'moonshot',
          requestedModel: 'kimi-k2.5',
          resolvedProvider: 'moonshot',
          resolvedModel: 'kimi-k2.5',
          reason: 'user-selected',
          role: null,
          billingMode: 'payg',
          fallbackFrom: null,
        },
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
          content: 'final',
          modelDecision: {
            requestedProvider: 'moonshot',
            requestedModel: 'kimi-k2.5',
            resolvedProvider: 'moonshot',
            resolvedModel: 'kimi-k2.5',
            reason: 'user-selected',
            role: null,
            billingMode: 'payg',
            fallbackFrom: null,
            toolPolicy: 'runtime-checked',
            toolStrategy: {
              visibleToolCount: 4,
              toolNamesPreview: ['Read', 'Edit', 'mcp__github__search_code'],
              mcpToolCount: 1,
              mcpServerIds: ['github'],
              programmaticToolCalling: 'available',
              programmaticToolCount: 4,
              tokenSavings: {
                status: 'estimated',
                savedTokens: 128,
                detail: 'estimated from visible tool schemas',
                basis: {
                  source: 'tool-spec-local-estimate',
                  toolCount: 4,
                  previewToolCount: 3,
                  fields: ['name', 'description', 'inputSchema', 'ignored'],
                },
              },
            },
          },
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

    expect(messages[0]?.modelDecision?.toolStrategy).toMatchObject({
      visibleToolCount: 4,
      mcpToolCount: 1,
      mcpServerIds: ['github'],
      programmaticToolCalling: 'available',
      tokenSavings: {
        status: 'estimated',
        savedTokens: 128,
        detail: 'estimated from visible tool schemas',
        basis: {
          source: 'tool-spec-local-estimate',
          toolCount: 4,
          previewToolCount: 3,
          fields: ['name', 'description', 'inputSchema'],
        },
      },
    });
  });

  it('normalizes provider-reported tool token savings from message events', () => {
    let messages: Message[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        content: 'draft',
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
          content: 'final',
          modelDecision: {
            requestedProvider: 'moonshot',
            requestedModel: 'kimi-k2.5',
            resolvedProvider: 'moonshot',
            resolvedModel: 'kimi-k2.5',
            reason: 'user-selected',
            role: null,
            billingMode: 'payg',
            fallbackFrom: null,
            toolPolicy: 'runtime-checked',
            toolStrategy: {
              visibleToolCount: 2,
              mcpToolCount: 0,
              programmaticToolCalling: 'available',
              programmaticToolCount: 2,
              tokenSavings: {
                status: 'provider-reported',
                savedTokens: 42,
                detail: 'provider reported savings',
                measurement: {
                  savingsSource: 'provider-reported',
                  usageSource: 'model-response-usage',
                  providerReportedSavings: true,
                },
                providerReport: {
                  source: 'provider-reported',
                  savedTokens: 42,
                },
                providerUsage: {
                  source: 'model-response-usage',
                  inputTokens: 500,
                  outputTokens: 50,
                  totalTokens: 550,
                },
              },
            },
          },
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

    expect(messages[0]?.modelDecision?.toolStrategy?.tokenSavings).toMatchObject({
      status: 'provider-reported',
      savedTokens: 42,
      detail: 'provider reported savings',
      measurement: {
        savingsSource: 'provider-reported',
        usageSource: 'model-response-usage',
        providerReportedSavings: true,
      },
      providerReport: {
        source: 'provider-reported',
        savedTokens: 42,
      },
      providerUsage: {
        source: 'model-response-usage',
        inputTokens: 500,
        outputTokens: 50,
        totalTokens: 550,
      },
    });
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
