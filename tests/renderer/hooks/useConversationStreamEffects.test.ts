import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  applyConversationStreamEvent,
  mergeCommittedAssistantContent,
  removeUncommittedAssistantDraft,
} from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import { parseModelFallbackNotice } from '../../../src/renderer/components/features/chat/fallbackNotice';

describe('removeUncommittedAssistantDraft', () => {
  it('removes an empty assistant draft that never produced anything', () => {
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
        content: '',
        timestamp: 120,
      },
    ];

    expect(removeUncommittedAssistantDraft(messages, 'turn-draft-1')).toEqual([
      messages[0],
    ]);
  });

  // 2026-08-01 真机 2/2：停止后横幅写「已经写出来的内容保留在上面」，
  // 而上面是空的——491 字的半截回答被这个函数连气泡一起删了。
  it('keeps a draft that already streamed text to the screen', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: '写一篇长文',
        timestamp: 100,
      },
      {
        id: 'turn-draft-1',
        role: 'assistant',
        content: '# 一条河的旅程\n\n我诞生于冰川裂缝...',
        timestamp: 120,
      },
    ];

    expect(removeUncommittedAssistantDraft(messages, 'turn-draft-1')).toBe(messages);
  });

  it('keeps a draft that only streamed reasoning', () => {
    const messages: Message[] = [
      {
        id: 'turn-draft-1',
        role: 'assistant',
        content: '',
        reasoning: '先梳理结构再动笔',
        timestamp: 120,
      },
    ];

    expect(removeUncommittedAssistantDraft(messages, 'turn-draft-1')).toBe(messages);
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

  it('drops the previous empty draft when a new turn starts without any committed assistant message', () => {
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
        content: '',
        timestamp: 120,
        toolCalls: [],
      },
    ];

    const state = {
      currentTurnMessageId: 'turn-1',
      committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
        metadata: { correlation: { turnId: 'turn-2' } },
      },
    ]);
    expect(state.currentTurnMessageId).toBe('turn-2');
  });
});

describe('applyConversationStreamEvent input redirect receipt', () => {
  it('keeps the user bubble and does not project a receipt card', () => {
    let messages: Message[] = [{
      id: 'redirect-message-1',
      role: 'user',
      content: '改用更简洁的结构',
      timestamp: 100,
    }];
    const actions = {
      addMessage: (message: Message) => { messages = [...messages, message]; },
      updateMessage: () => {},
      setMessages: (next: Message[]) => { messages = next; },
      getMessages: () => messages,
      queueUpdate: () => {},
      now: () => 123,
    };
    const event = {
      type: 'input_redirected',
      data: {
        receiptId: 'redirect-receipt-1',
        originalContent: '改用更简洁的结构',
        expectedTurnId: 'turn-1',
        partial: { charCount: 88, trailingText: '写到这里' },
        interruptedTools: ['Bash'],
      },
    };
    const state = { currentTurnMessageId: 'turn-1', committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() };

    applyConversationStreamEvent(event, state, actions);
    applyConversationStreamEvent(event, state, actions);

    expect(messages).toEqual([expect.objectContaining({
      id: 'redirect-message-1',
      role: 'user',
      content: '改用更简洁的结构',
    })]);
    expect(messages.some((message) => message.metadata?.inputRedirectReceipt)).toBe(false);
  });
});

// 2026-08-01 验收截图：宿主抽干排队消息那一轮，屏幕上只有回答「丙一收到」，
// 对应的问题一个字都没有——那条用户消息只有宿主知道，前端没有本地乐观副本。
describe('applyConversationStreamEvent host-owned user message', () => {
  const makeActions = (messagesRef: { current: Message[] }) => ({
    addMessage: (message: Message) => {
      messagesRef.current = [...messagesRef.current, message];
    },
    updateMessage: () => {},
    setMessages: (next: Message[]) => {
      messagesRef.current = next;
    },
    getMessages: () => messagesRef.current,
    queueUpdate: () => {},
    now: () => 500,
    generateId: () => 'generated',
  });

  it('adds the user bubble broadcast by a host-started turn', () => {
    const messagesRef = { current: [] as Message[] };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: {
          id: 'queued-input-1',
          role: 'user',
          content: 'C2QUEUED-RUN1 只回复四个字：丙一收到',
          timestamp: 400,
        },
      },
      { currentTurnMessageId: null, committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() },
      makeActions(messagesRef),
    );

    expect(messagesRef.current).toEqual([
      {
        id: 'queued-input-1',
        role: 'user',
        content: 'C2QUEUED-RUN1 只回复四个字：丙一收到',
        timestamp: 400,
      },
    ]);
  });

  it('is idempotent when the bubble is already on screen', () => {
    const existing: Message = {
      id: 'queued-input-1',
      role: 'user',
      content: '已经在屏幕上了',
      timestamp: 400,
    };
    const messagesRef = { current: [existing] };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: { id: 'queued-input-1', role: 'user', content: '已经在屏幕上了', timestamp: 400 },
      },
      { currentTurnMessageId: null, committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() },
      makeActions(messagesRef),
    );

    expect(messagesRef.current).toEqual([existing]);
  });

  it('still merges assistant commits into the streaming draft', () => {
    const messagesRef = {
      current: [
        { id: 'turn-1', role: 'assistant', content: '半截', timestamp: 300 } as Message,
      ],
    };

    applyConversationStreamEvent(
      {
        type: 'message',
        data: { id: 'turn-1', turnId: 'turn-1', content: '完整回答' },
      },
      { currentTurnMessageId: 'turn-1', committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() },
      {
        ...makeActions(messagesRef),
        updateMessage: (id: string, changes: Partial<Message>) => {
          messagesRef.current = messagesRef.current.map((message) => (
            message.id === id ? { ...message, ...changes } : message
          ));
        },
      },
    );

    expect(messagesRef.current[0].content).toBe('完整回答');
  });
});


describe('applyConversationStreamEvent plan_approval_update', () => {
  const planMessage: Message = {
    id: 'message-plan',
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [{
      id: 'tool-plan',
      name: 'exit_plan_mode',
      arguments: {},
      result: {
        toolCallId: 'tool-plan',
        success: true,
        metadata: { planApproval: { status: 'starting', originalPlan: '1. Read', steps: [] } },
      },
    }],
  };

  it('把宿主异步落定的审批记录合进消息副本（failed 卡据此重现）', () => {
    const messagesRef = { current: [planMessage] };
    const updated: Message[] = [];
    const actions = {
      addMessage: () => {},
      updateMessage: (id: string, patch: Partial<Message>) => {
        updated.push({ id, ...patch } as Message);
      },
      setMessages: (next: Message[]) => {
        messagesRef.current = next;
      },
      getMessages: () => messagesRef.current,
      queueUpdate: () => {},
      now: () => 500,
      generateId: () => 'generated',
    };

    applyConversationStreamEvent(
      {
        type: 'plan_approval_update',
        data: {
          sessionId: 'session-1',
          messageId: 'message-plan',
          toolCallId: 'tool-plan',
          approval: {
            status: 'failed',
            originalPlan: '1. Read',
            steps: [],
            failureReason: 'Session s1 is already running',
          },
        },
      },
      { currentTurnMessageId: null, committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(), segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() },
      actions,
    );

    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('message-plan');
    const record = updated[0].toolCalls?.[0].result?.metadata?.planApproval as { status: string; failureReason?: string };
    expect(record).toMatchObject({ status: 'failed', failureReason: 'Session s1 is already running' });
    // 原消息对象不被就地改写。
    expect((planMessage.toolCalls?.[0].result?.metadata?.planApproval as { status: string }).status).toBe('starting');
  });

  it('消息不在本地时不动作', () => {
    const actions = {
      addMessage: () => {},
      updateMessage: () => {
        throw new Error('must not update');
      },
      setMessages: () => {},
      getMessages: () => [] as Message[],
      queueUpdate: () => {},
      now: () => 500,
      generateId: () => 'generated',
    };
    applyConversationStreamEvent(
      {
        type: 'plan_approval_update',
        data: {
          sessionId: 'session-1',
          messageId: 'message-gone',
          toolCallId: 'tool-plan',
          approval: { status: 'approved', originalPlan: '1. Read', steps: [] },
        },
      },
      { currentTurnMessageId: null, committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(), segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() },
      actions,
    );
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
  it('keeps foreground turn_start behavior unchanged', () => {
    const addMessage = vi.fn();
    const state = {
      currentTurnMessageId: null,
      committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };

    applyConversationStreamEvent(
      {
        type: 'turn_start',
        data: {
          turnId: 'foreground-turn',
          iteration: 1,
        },
      },
      state,
      {
        addMessage,
        updateMessage: vi.fn(),
        setMessages: vi.fn(),
        getMessages: () => [],
        queueUpdate: vi.fn(),
      },
    );

    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'foreground-turn',
      role: 'assistant',
    }));
    expect(state.currentTurnMessageId).toBe('foreground-turn');
  });

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
      lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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

describe('applyConversationStreamEvent turn_start replay', () => {
  it('does not create a second assistant bubble when the same turnId is replayed', () => {
    let messages: Message[] = [];
    const state = {
      currentTurnMessageId: null as string | null,
      committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };
    const actions = {
      addMessage: (message: Message) => {
        messages = [...messages, message];
      },
      updateMessage: () => {},
      setMessages: (next: Message[]) => {
        messages = next;
      },
      getMessages: () => messages,
      queueUpdate: () => {},
    };

    applyConversationStreamEvent(
      { type: 'turn_start', data: { turnId: 'turn-1' } },
      state,
      actions,
    );
    applyConversationStreamEvent(
      { type: 'stream_chunk', data: { turnId: 'turn-1', content: 'hello' } },
      state,
      { ...actions, appendStreamingMessageDelta: (messageId, delta) => {
        messages = messages.map((message) => (
          message.id === messageId
            ? { ...message, content: `${message.content}${delta.content ?? ''}` }
            : message
        ));
      } },
    );
    applyConversationStreamEvent(
      { type: 'turn_start', data: { turnId: 'turn-1' } },
      state,
      actions,
    );

    expect(messages.filter((message) => message.id === 'turn-1')).toHaveLength(1);
    expect(messages[0]?.content).toBe('hello');
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
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

// ── 费用管线接线（stream_usage / model_decision → statusStore）───────────────
import { useStatusStore } from '../../../src/renderer/stores/statusStore';

function costStreamHarness() {
  return {
    state: { currentTurnMessageId: null, committedAssistantMessageIds: new Set<string>(), lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>() },
    actions: {
      addMessage: vi.fn(),
      appendStreamingMessageDelta: vi.fn(),
      updateMessage: vi.fn(),
      setMessages: vi.fn(),
      getMessages: () => [] as Message[],
      queueUpdate: (fn: () => void) => fn(),
    },
  };
}

describe('turn cost stream wiring', () => {
  it('model_decision records the resolved model, stream_usage books the turn cost', () => {
    useStatusStore.getState().resetSession();
    const { state, actions } = costStreamHarness();

    applyConversationStreamEvent(
      {
        type: 'model_decision',
        sessionId: 's1',
        data: {
          requestedProvider: 'deepseek', requestedModel: 'deepseek-v4-pro',
          resolvedProvider: 'deepseek', resolvedModel: 'deepseek-v4-pro',
          reason: 'user-selected', billingMode: 'payg',
        },
      } as never,
      state as never,
      actions as never,
    );
    expect(useStatusStore.getState().currentTurnModel).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });

    applyConversationStreamEvent(
      { type: 'stream_usage', sessionId: 's1', data: { inputTokens: 1_000_000, outputTokens: 0 } } as never,
      state as never,
      actions as never,
    );
    const s = useStatusStore.getState();
    expect(s.lastTurnCost?.usd).toBeGreaterThan(0);
    expect(s.sessionCost).toBeGreaterThan(0);
  });

  it('stream_usage without token fields is ignored (no NaN bookkeeping)', () => {
    useStatusStore.getState().resetSession();
    const { state, actions } = costStreamHarness();
    applyConversationStreamEvent(
      { type: 'stream_usage', sessionId: 's1', data: {} } as never,
      state as never,
      actions as never,
    );
    expect(useStatusStore.getState().lastTurnCost).toBeNull();
  });
});

// ai-review #1696 两轮各撞一次：字符串比对判不了重放——合法的重复正文与重放长得一样，
// 按内容丢就吞真内容（前缀裁剪丢字、整段全等吞段）。事件本来就带 deltaSeq，
// host 的 messageDeltaAccumulator.acceptDelta 早就按它判，渲染层照抄同一口径。
describe('applyConversationStreamEvent 按 deltaSeq 判重放', () => {
  const LONG = '这是一段足够长的正文用来越过整段全等的最小长度门槛不少于三十二个字符';

  function harness() {
    const messagesRef = { current: [] as Message[] };
    const actions = {
      addMessage: (message: Message) => { messagesRef.current = [...messagesRef.current, message]; },
      updateMessage: (id: string, updates: Partial<Message>) => {
        messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...updates } : m));
      },
      appendStreamingMessageDelta: (messageId: string, delta: { content?: string }) => {
        messagesRef.current = messagesRef.current.map((m) => (
          m.id === messageId ? { ...m, content: (m.content || '') + (delta.content || '') } : m
        ));
      },
      setMessages: (next: Message[]) => { messagesRef.current = next; },
      getMessages: () => messagesRef.current,
      queueUpdate: () => {},
      now: () => 1,
    };
    const state = {
      currentTurnMessageId: 'turn-seq',
      committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };
    messagesRef.current = [{ id: 'turn-seq', role: 'assistant', content: '', timestamp: 1 }];
    return { messagesRef, actions, state };
  }

  const chunk = (content: string, deltaSeq: number) => ({
    type: 'stream_chunk',
    data: { turnId: 'turn-seq', content, deltaSeq },
  });

  it('序号递增的两段相同长正文都要留下（不是重放）', () => {
    const { messagesRef, actions, state } = harness();
    applyConversationStreamEvent(chunk(LONG, 1), state, actions as never);
    applyConversationStreamEvent(chunk(LONG, 2), state, actions as never);
    expect(messagesRef.current[0].content).toBe(LONG + LONG);
  });

  // 生产里 state 是每次调用现造的对象字面量，Map 必须由外部 ref 持有。
  // 夹具照生产的样子造：每次调用都换一个新的 state 外壳，只共享那个 Map。
  it('state 每次现造时序号去重仍然生效（Map 由外部持有）', () => {
    const { messagesRef, actions } = harness();
    const shared = new Map<string, number>();
    let currentTurnMessageId: string | null = 'turn-seq';
    const freshState = () => ({
      get currentTurnMessageId() { return currentTurnMessageId; },
      set currentTurnMessageId(v: string | null) { currentTurnMessageId = v; },
      committedAssistantMessageIds: new Set<string>(),
      lastDeltaSeqByTurn: shared,
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    });
    applyConversationStreamEvent(chunk(LONG, 1), freshState(), actions as never);
    applyConversationStreamEvent(chunk(LONG, 1), freshState(), actions as never);
    expect(messagesRef.current[0].content).toBe(LONG);
  });

  it('message_delta 分支同样按序号去重（生产里带 deltaSeq 的是它）', () => {
    const { messagesRef, actions, state } = harness();
    const delta = (text: string, deltaSeq: number) => ({
      type: 'message_delta',
      data: { role: 'assistant', messageId: 'turn-seq', path: 'content', op: 'append', text, deltaSeq },
    });
    applyConversationStreamEvent(delta(LONG, 1), state, actions as never);
    applyConversationStreamEvent(delta(LONG, 1), state, actions as never);
    expect(messagesRef.current[0].content).toBe(LONG);
    applyConversationStreamEvent(delta(LONG, 2), state, actions as never);
    expect(messagesRef.current[0].content).toBe(LONG + LONG);
  });

  // ai-review #1696 第五轮③：无 deltaSeq 时判不了重放（合法的重复正文与重放长得一样）。
  // 方向固定为宁可重复：重复看得见、能被后续权威快照纠正；丢字是静默的。
  it('没有 deltaSeq 时不按内容丢，两段相同长正文都留下', () => {
    const { messagesRef, actions, state } = harness();
    const noSeq = (content: string) => ({
      type: 'stream_chunk',
      data: { turnId: 'turn-seq', content },
    });
    applyConversationStreamEvent(noSeq(LONG), state, actions as never);
    applyConversationStreamEvent(noSeq(LONG), state, actions as never);
    expect(messagesRef.current[0].content).toBe(LONG + LONG);
  });

  it('序号回头的同一段只算一次（重放）', () => {
    const { messagesRef, actions, state } = harness();
    applyConversationStreamEvent(chunk(LONG, 1), state, actions as never);
    applyConversationStreamEvent(chunk(LONG, 1), state, actions as never);
    expect(messagesRef.current[0].content).toBe(LONG);
  });
});

// ============================================================================
// ADR-068 刀 4：断流续接信号（stream_reconnecting）与 B2 诚实分段
// ============================================================================
import { useStreamResumeStore } from '../../../src/renderer/stores/streamResumeStore';

describe('applyConversationStreamEvent stream_reconnecting（ADR-068 刀 4）', () => {
  const makeResumeHarness = () => {
    const messagesRef = { current: [
      { id: 'user-1', role: 'user', content: '写一段', timestamp: 100 },
      { id: 'turn-b2', role: 'assistant', content: 'PART1__断点片段。', timestamp: 120, toolCalls: [] },
    ] as Message[] };
    const activity: string[] = [];
    const actions = {
      addMessage: (message: Message) => { messagesRef.current = [...messagesRef.current, message]; },
      appendStreamingMessageDelta: (messageId: string, delta: { content?: string; reasoning?: string }) => {
        messagesRef.current = messagesRef.current.map((m) => (
          m.id === messageId ? { ...m, content: `${m.content}${delta.content ?? ''}` } : m
        ));
      },
      updateMessage: (id: string, updates: Partial<Message>) => {
        messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...updates } : m));
      },
      setMessages: (next: Message[]) => { messagesRef.current = next; },
      getMessages: () => messagesRef.current,
      queueUpdate: () => {},
      now: () => 500,
      generateId: (() => { let n = 0; return () => `segment-${++n}`; })(),
      // 照生产接线（hook 里挂的就是 store 的恢复探测），另记录调用序供断言
      notifyStreamResumeActivity: (messageId: string) => {
        activity.push(messageId);
        useStreamResumeStore.getState().resolveIfActivityOn(messageId);
      },
    };
    const state = {
      currentTurnMessageId: 'turn-b2',
      committedAssistantMessageIds: new Set<string>(),
      lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };
    return { messagesRef, actions, state, activity };
  };

  beforeEach(() => { useStreamResumeStore.getState().clear(); });
  afterEach(() => { useStreamResumeStore.getState().clear(); });

  it('B1：只挂信号不分段——状态行挂当前 streaming 消息，同轮同消息续打', () => {
    const { messagesRef, actions, state } = makeResumeHarness();

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b1' } },
      state,
      actions,
    );

    // 不新开第二条消息（B1 无缝续打，delta 无缝继续）
    expect(messagesRef.current).toHaveLength(2);
    expect(state.currentTurnMessageId).toBe('turn-b2');
    const signal = useStreamResumeStore.getState().signal;
    expect(signal).toMatchObject({ turnId: 'turn-b2', messageId: 'turn-b2', attempt: 1, maxReconnects: 2 });
    expect(signal?.segmentMessageId).toBeUndefined();
  });

  it('B2：断点段定格 + 续答另起一段带一次性说明；后续 delta 重定向到续答段不拼缝；恢复即消信号', () => {
    const { messagesRef, actions, state, activity } = makeResumeHarness();

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );

    // 断点段定格（PART1 原样保留）+ 续答段（带一次性续接说明，一次性=仅流中）
    expect(messagesRef.current).toHaveLength(3);
    const segment = messagesRef.current[2];
    expect(segment.role).toBe('assistant');
    expect(segment.content).toBe('');
    expect(segment.metadata?.streamResumeNote).toEqual({ attempt: 1, maxReconnects: 2 });
    expect(messagesRef.current[1].content).toBe('PART1__断点片段。');
    // 信号挂断点段（PART1），并登记续答段
    expect(useStreamResumeStore.getState().signal).toMatchObject({
      turnId: 'turn-b2', messageId: 'turn-b2', segmentMessageId: 'segment-1',
    });
    expect(state.currentTurnMessageId).toBe('segment-1');

    // host 的续答 delta 仍按原 turnId 寻址 → 重定向到续答段，绝不 append 进断点段（D2）
    applyConversationStreamEvent(
      { type: 'message_delta', data: { role: 'assistant', path: 'content', op: 'append', text: 'PART2__续答。', messageId: 'turn-b2', turnId: 'turn-b2', deltaSeq: 1 } },
      state,
      actions,
    );
    expect(messagesRef.current[1].content).toBe('PART1__断点片段。'); // 断点段纹丝不动
    expect(messagesRef.current[2].content).toBe('PART2__续答。'); // 续答落到新段
    // 续答恢复即消除信号（状态行消失，B2 呈现交给续答段的一次性说明）
    expect(useStreamResumeStore.getState().signal).toBeNull();
    expect(activity).toContain('segment-1');
  });

  it('B2 重放幂等：同一条信号重放不二次切段（SSE Last-Event-ID 重连场景）', () => {
    const { messagesRef, actions, state } = makeResumeHarness();
    const signal = { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b2' } as const;

    applyConversationStreamEvent({ type: 'stream_reconnecting', data: signal }, state, actions);
    const segmentId = state.currentTurnMessageId;
    applyConversationStreamEvent({ type: 'stream_reconnecting', data: signal }, state, actions);

    expect(messagesRef.current).toHaveLength(3); // 只切了一次段
    expect(state.currentTurnMessageId).toBe(segmentId);
    expect(useStreamResumeStore.getState().signal).toMatchObject({ segmentMessageId: segmentId });
  });

  it('B2 第二次断流：续答段也定格，attempt 递增切新段', () => {
    const { messagesRef, actions, state } = makeResumeHarness();

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );
    applyConversationStreamEvent(
      { type: 'message_delta', data: { role: 'assistant', path: 'content', op: 'append', text: 'PART2 半截。', messageId: 'turn-b2', deltaSeq: 1 } },
      state,
      actions,
    );
    useStreamResumeStore.getState().clear(); // 恢复后信号已消（两次断流之间正常续过）
    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 2, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );

    // 第二刀切在续答段上：segment-1 定格，segment-2 是新的续答段
    expect(messagesRef.current).toHaveLength(4);
    expect(messagesRef.current[2].content).toBe('PART2 半截。');
    expect(state.currentTurnMessageId).toBe('segment-2');
    expect(useStreamResumeStore.getState().signal).toMatchObject({
      messageId: 'segment-1', segmentMessageId: 'segment-2', attempt: 2,
    });
  });

  it('commit 落到续答段：终稿替换续答段内容（不顶掉断点段），信号随 commit 消除', () => {
    const { messagesRef, actions, state } = makeResumeHarness();

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );
    applyConversationStreamEvent(
      { type: 'message_delta', data: { role: 'assistant', path: 'content', op: 'append', text: 'PART2 流中。', messageId: 'turn-b2', deltaSeq: 1 } },
      state,
      actions,
    );

    // 终稿 commit（host assistant message 事件不带顶层 turnId → 寻址 currentTurnMessageId）
    applyConversationStreamEvent(
      { type: 'message', data: { id: 'final-1', role: 'assistant', content: 'PART2__终稿。', toolCalls: [] } },
      state,
      actions,
    );

    expect(messagesRef.current[1].content).toBe('PART1__断点片段。'); // 断点段不被顶替
    expect(messagesRef.current[2].content).toBe('PART2__终稿。'); // 终稿落续答段
    expect(useStreamResumeStore.getState().signal).toBeNull();
  });

  it('旧轮迟到的 stream_reconnecting 不碰新轮消息：带 turnId 只对账该轮，找不属地消息就丢弃（ai-review Important）', () => {
    const messagesRef = { current: [
      { id: 'user-1', role: 'user', content: '写一段', timestamp: 100 },
      { id: 'turn-old', role: 'assistant', content: '旧轮断点片段。', timestamp: 120, toolCalls: [] },
      { id: 'user-2', role: 'user', content: '再写一段', timestamp: 200 },
      { id: 'turn-new', role: 'assistant', content: '新轮回答正文。', timestamp: 220, toolCalls: [] },
    ] as Message[] };
    const actions = {
      addMessage: (message: Message) => { messagesRef.current = [...messagesRef.current, message]; },
      updateMessage: (id: string, updates: Partial<Message>) => {
        messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...updates } : m));
      },
      setMessages: (next: Message[]) => { messagesRef.current = next; },
      getMessages: () => messagesRef.current,
      queueUpdate: (update: { type: string; messageId: string; content?: string }) => {
        if (update.type === 'append' && update.content) {
          messagesRef.current = messagesRef.current.map((m) => (
            m.id === update.messageId ? { ...m, content: `${m.content}${update.content}` } : m
          ));
        }
      },
      now: () => 500,
    };
    const state = {
      // 新轮已是 current；旧轮的迟到信号带自己的 turnId 到达
      currentTurnMessageId: 'turn-new',
      committedAssistantMessageIds: new Set<string>(),
      lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-old', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );

    // 新轮消息纹丝不动：不切段、不建重定向、新轮 current 不被顶掉
    expect(messagesRef.current).toHaveLength(4);
    expect(messagesRef.current[3].content).toBe('新轮回答正文。');
    expect(state.currentTurnMessageId).toBe('turn-new');
    expect(state.segmentRedirectByTurn.size).toBe(0);
    // 死轮信号整条丢弃：连信号都不挂（那轮已收尾，冻结消息就是它的诚实终态）
    expect(useStreamResumeStore.getState().signal).toBeNull();
    // 新轮 delta 照常落新轮消息（无重定向劫持）
    applyConversationStreamEvent(
      { type: 'message_delta', data: { role: 'assistant', path: 'content', op: 'append', text: '（续）', messageId: 'turn-new', deltaSeq: 1 } },
      state,
      actions,
    );
    expect(messagesRef.current[3].content).toBe('新轮回答正文。（续）');
  });

  it('turn_start 新轮：旧轮信号与分段重定向过期（终态之外的第二道清除）', () => {
    const { actions, state } = makeResumeHarness();

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );
    applyConversationStreamEvent(
      { type: 'turn_start', data: { turnId: 'turn-next' } },
      state,
      actions,
    );

    expect(useStreamResumeStore.getState().signal).toBeNull();
    expect(state.segmentRedirectByTurn.size).toBe(0);
    // 同轮 turn_start 重放不清自己的重定向（清了会把续答接回断点段）
    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-b2', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      { ...state, currentTurnMessageId: null },
      actions,
    );
    applyConversationStreamEvent(
      { type: 'turn_start', data: { turnId: 'turn-b2' } },
      state,
      actions,
    );
    expect(state.segmentRedirectByTurn.has('turn-b2')).toBe(true);
  });

  it('空断点 B2：无可分段正文（host 侧 partial 落库本就是 no-op）只挂信号不切段', () => {
    const messagesRef = { current: [
      { id: 'turn-empty', role: 'assistant', content: '', timestamp: 120, toolCalls: [] },
    ] as Message[] };
    const actions = {
      addMessage: (message: Message) => { messagesRef.current = [...messagesRef.current, message]; },
      updateMessage: () => {},
      setMessages: (next: Message[]) => { messagesRef.current = next; },
      getMessages: () => messagesRef.current,
      queueUpdate: () => {},
      now: () => 500,
    };
    const state = {
      currentTurnMessageId: 'turn-empty',
      committedAssistantMessageIds: new Set<string>(),
      lastDeltaSeqByTurn: new Map<string, number>(),
      segmentRedirectByTurn: new Map<string, { segmentId: string; splitAtAttempt: number }>(),
    };

    applyConversationStreamEvent(
      { type: 'stream_reconnecting', data: { turnId: 'turn-empty', attempt: 1, maxReconnects: 2, segment: 'b2' } },
      state,
      actions,
    );

    expect(messagesRef.current).toHaveLength(1);
    expect(useStreamResumeStore.getState().signal).toMatchObject({ messageId: 'turn-empty' });
  });
});

describe('streamResumeStore 信号生命周期（ADR-068 刀 4：一屏一个信号）', () => {
  beforeEach(() => { useStreamResumeStore.getState().clear(); });
  afterEach(() => { useStreamResumeStore.getState().clear(); });

  it('setSignal 覆写 n/N（连续断流递增），全局单例', () => {
    const store = useStreamResumeStore.getState();
    store.setSignal({ turnId: 't1', messageId: 'm1', attempt: 1, maxReconnects: 2, signaledAt: 1 });
    store.setSignal({ turnId: 't1', messageId: 'm1', attempt: 2, maxReconnects: 2, signaledAt: 2 });

    expect(useStreamResumeStore.getState().signal).toMatchObject({ attempt: 2, maxReconnects: 2, messageId: 'm1' });
  });

  it('attachSegment 补登记 B2 续答段；无信号时 no-op', () => {
    useStreamResumeStore.getState().attachSegment('seg-1');
    expect(useStreamResumeStore.getState().signal).toBeNull();

    useStreamResumeStore.getState().setSignal({ turnId: 't1', messageId: 'm1', attempt: 1, maxReconnects: 2, signaledAt: 1 });
    useStreamResumeStore.getState().attachSegment('seg-1');
    expect(useStreamResumeStore.getState().signal).toMatchObject({ segmentMessageId: 'seg-1' });
  });

  it('resolveIfActivityOn：命中挂载消息（B1 无缝续打）或续答段（B2）都算恢复；别的消息不动', () => {
    const store = useStreamResumeStore.getState();
    store.setSignal({ turnId: 't1', messageId: 'm1', attempt: 1, maxReconnects: 2, signaledAt: 1 });
    useStreamResumeStore.getState().attachSegment('seg-1');

    // 无关消息的流活动不打断信号（同一屏里别的消息在动 ≠ 断流恢复了）
    useStreamResumeStore.getState().resolveIfActivityOn('other');
    expect(useStreamResumeStore.getState().signal).not.toBeNull();

    // B1：续答 delta 回到同一消息
    useStreamResumeStore.getState().resolveIfActivityOn('m1');
    expect(useStreamResumeStore.getState().signal).toBeNull();

    // B2：续答 delta 落到续答段
    useStreamResumeStore.getState().setSignal({ turnId: 't1', messageId: 'm1', segmentMessageId: 'seg-1', attempt: 1, maxReconnects: 2, signaledAt: 3 });
    useStreamResumeStore.getState().resolveIfActivityOn('seg-1');
    expect(useStreamResumeStore.getState().signal).toBeNull();

    // 空 messageId / 无信号时安全 no-op
    useStreamResumeStore.getState().resolveIfActivityOn(undefined);
    useStreamResumeStore.getState().resolveIfActivityOn('m1');
  });
});
