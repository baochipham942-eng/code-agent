import { describe, it, expect } from 'vitest';
import {
  isRecord,
  getStringField,
  getNumberField,
  getBooleanField,
  normalizeTurnIdPayload,
  normalizeStreamTextPayload,
  normalizeMessageDeltaPayload,
  normalizeMessageSnapshotPayload,
  normalizeAssistantMessagePayload,
  normalizeRoutingResolvedPayload,
  normalizeModelDecisionPayload,
  normalizeModelFallbackPayload,
  normalizeHookTriggerData,
} from '@renderer/hooks/agent/effects/streamEventNormalizers';

// 这些 normalizer 是 SSE 流事件进入 renderer 前的契约闸门：把后端发来的
// unknown 校验成强类型 payload，畸形输入返回 null/undefined。覆盖正例 + 各类
// 畸形负例，同时通过 normalizeModelDecisionPayload/normalizeModelFallbackPayload
// 喂深层嵌套，驱动内部的 provider 健康 / 引擎快照 / 工具策略等子 normalizer。

describe('字段访问器', () => {
  it('isRecord 仅对非 null 对象为真', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true); // 数组也是 object
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(3)).toBe(false);
  });

  it('getStringField 只接受 string', () => {
    expect(getStringField({ a: 'hi' }, 'a')).toBe('hi');
    expect(getStringField({ a: 3 }, 'a')).toBeUndefined();
    expect(getStringField({ a: '' }, 'a')).toBe('');
    expect(getStringField({}, 'missing')).toBeUndefined();
  });

  it('getNumberField 只接受 number', () => {
    expect(getNumberField({ a: 3 }, 'a')).toBe(3);
    expect(getNumberField({ a: 0 }, 'a')).toBe(0);
    expect(getNumberField({ a: '3' }, 'a')).toBeUndefined();
    expect(getNumberField({}, 'a')).toBeUndefined();
  });

  it('getBooleanField 只接受 boolean', () => {
    expect(getBooleanField({ a: true }, 'a')).toBe(true);
    expect(getBooleanField({ a: false }, 'a')).toBe(false);
    expect(getBooleanField({ a: 'true' }, 'a')).toBeUndefined();
    expect(getBooleanField({}, 'a')).toBeUndefined();
  });
});

describe('normalizeTurnIdPayload', () => {
  it('非对象返回空对象', () => {
    expect(normalizeTurnIdPayload(null)).toEqual({});
    expect(normalizeTurnIdPayload('x')).toEqual({});
  });

  it('提取 turnId 与 isMeta', () => {
    expect(normalizeTurnIdPayload({ turnId: 't1', isMeta: true })).toEqual({ turnId: 't1', isMeta: true });
  });

  it('isMeta=false 时不带该字段；turnId 非 string 被丢弃', () => {
    expect(normalizeTurnIdPayload({ turnId: 1, isMeta: false })).toEqual({});
  });
});

describe('normalizeStreamTextPayload', () => {
  it('非对象或缺 content 返回 null', () => {
    expect(normalizeStreamTextPayload(null)).toBeNull();
    expect(normalizeStreamTextPayload({})).toBeNull();
    expect(normalizeStreamTextPayload({ content: 3 })).toBeNull();
  });

  it('空字符串 content 合法', () => {
    expect(normalizeStreamTextPayload({ content: '' })).toEqual({ content: '' });
  });

  it('携带 turnId / isMeta', () => {
    expect(normalizeStreamTextPayload({ content: 'hi', turnId: 't', isMeta: true })).toEqual({
      content: 'hi',
      turnId: 't',
      isMeta: true,
    });
  });
});

describe('normalizeMessageDeltaPayload', () => {
  it('role 非 assistant 或缺 text 返回 null', () => {
    expect(normalizeMessageDeltaPayload({ role: 'user', text: 'x' })).toBeNull();
    expect(normalizeMessageDeltaPayload({ role: 'assistant' })).toBeNull();
    expect(normalizeMessageDeltaPayload(null)).toBeNull();
  });

  it('默认 path=content op=append', () => {
    expect(normalizeMessageDeltaPayload({ role: 'assistant', text: 'a' })).toMatchObject({
      role: 'assistant',
      path: 'content',
      op: 'append',
      text: 'a',
    });
  });

  it('reasoning path + replace op + 可选字段', () => {
    expect(
      normalizeMessageDeltaPayload({
        role: 'assistant',
        text: 'a',
        path: 'reasoning',
        op: 'replace',
        turnId: 't',
        messageId: 'm',
        isMeta: true,
      }),
    ).toEqual({
      role: 'assistant',
      path: 'reasoning',
      op: 'replace',
      text: 'a',
      turnId: 't',
      messageId: 'm',
      isMeta: true,
    });
  });
});

describe('normalizeMessageSnapshotPayload', () => {
  it('role 非 assistant 或缺 content 返回 null', () => {
    expect(normalizeMessageSnapshotPayload({ role: 'user', content: 'x' })).toBeNull();
    expect(normalizeMessageSnapshotPayload({ role: 'assistant' })).toBeNull();
  });

  it('提取 content + reasoning + 可选 id', () => {
    expect(
      normalizeMessageSnapshotPayload({
        role: 'assistant',
        content: 'c',
        reasoning: 'r',
        turnId: 't',
        messageId: 'm',
        isMeta: true,
      }),
    ).toEqual({
      role: 'assistant',
      content: 'c',
      reasoning: 'r',
      turnId: 't',
      messageId: 'm',
      isMeta: true,
    });
  });
});

describe('normalizeAssistantMessagePayload', () => {
  it('非对象返回 null', () => {
    expect(normalizeAssistantMessagePayload(null)).toBeNull();
  });

  it('空对象返回空 payload', () => {
    expect(normalizeAssistantMessagePayload({})).toEqual({});
  });

  it('过滤非法 toolCall / artifact / contentPart', () => {
    const result = normalizeAssistantMessagePayload({
      id: 'a1',
      turnId: 't',
      content: 'hi',
      reasoning: 'r',
      thinking: 'th',
      isMeta: true,
      toolCalls: [
        { id: 'tc1', name: 'read', arguments: { path: '/x' } },
        { id: 'tc2', name: 'bad' }, // 无 arguments → 兜底成 {}
        { name: 'no-id' }, // 缺 id → 丢弃
        'not-a-record', // 丢弃
      ],
      artifacts: [
        { id: 'art1', type: 'chart', content: '{}', version: 1 },
        { id: 'art2', type: 'unknown-type', content: '{}', version: 1 }, // 非法 type 丢弃
        { id: 'art3', type: 'document', content: 123, version: 1 }, // content 非 string 丢弃
      ],
      contentParts: [
        { type: 'text', text: 'hello' },
        { type: 'tool_call', toolCallId: 'tc1' },
        { type: 'text' }, // 缺 text 丢弃
        { type: 'image' }, // 未知类型丢弃
      ],
    });
    expect(result).toMatchObject({
      id: 'a1',
      turnId: 't',
      content: 'hi',
      reasoning: 'r',
      thinking: 'th',
      isMeta: true,
    });
    expect(result?.toolCalls).toHaveLength(2);
    expect(result?.toolCalls?.[1]).toMatchObject({ id: 'tc2', name: 'bad', arguments: {} });
    expect(result?.artifacts).toHaveLength(1);
    expect(result?.artifacts?.[0]).toMatchObject({ id: 'art1', type: 'chart' });
    expect(result?.contentParts).toHaveLength(2);
  });

  it('空 toolCalls 数组保留为 []，非数组 artifacts 与全非法 contentParts 被丢弃', () => {
    const result = normalizeAssistantMessagePayload({
      content: '',
      toolCalls: [],
      artifacts: 'not-array',
      contentParts: [{ type: 'image' }],
    });
    expect(result).toEqual({ content: '', toolCalls: [] });
  });
});

describe('normalizeRoutingResolvedPayload', () => {
  it('mode 非 auto 返回 null', () => {
    expect(normalizeRoutingResolvedPayload({ mode: 'manual' })).toBeNull();
  });

  it('缺必填字段返回 null', () => {
    expect(normalizeRoutingResolvedPayload({ mode: 'auto', agentId: 'a' })).toBeNull();
    expect(
      normalizeRoutingResolvedPayload({ mode: 'auto', agentId: 'a', agentName: 'n', reason: 'r' }),
    ).toBeNull(); // 缺 score
  });

  it('完整 + 可选 timestamp / fallbackToDefault', () => {
    expect(
      normalizeRoutingResolvedPayload({
        mode: 'auto',
        agentId: 'a',
        agentName: 'n',
        reason: 'r',
        score: 0.9,
        timestamp: 123,
        fallbackToDefault: false,
      }),
    ).toEqual({
      mode: 'auto',
      agentId: 'a',
      agentName: 'n',
      reason: 'r',
      score: 0.9,
      timestamp: 123,
      fallbackToDefault: false,
    });
  });

  it('mode explicit（显式选择命中）+ requestedAgentId 透传', () => {
    expect(
      normalizeRoutingResolvedPayload({
        mode: 'explicit',
        agentId: 'explore',
        agentName: 'Explorer',
        reason: 'Explicit agent selected: explore',
        score: 1000,
        timestamp: 456,
        fallbackToDefault: false,
        requestedAgentId: 'explore',
      }),
    ).toEqual({
      mode: 'explicit',
      agentId: 'explore',
      agentName: 'Explorer',
      reason: 'Explicit agent selected: explore',
      score: 1000,
      timestamp: 456,
      fallbackToDefault: false,
      requestedAgentId: 'explore',
    });
  });

  it('降级场景：requestedAgentId ≠ agentId 保留（显式选择失败回落）', () => {
    const result = normalizeRoutingResolvedPayload({
      mode: 'explicit',
      agentId: 'default',
      agentName: 'default',
      reason: 'Requested agent "__ghost__" is unavailable; continuing with the default conversation loop.',
      score: 0,
      fallbackToDefault: true,
      requestedAgentId: '__ghost__',
    });
    expect(result?.mode).toBe('explicit');
    expect(result?.requestedAgentId).toBe('__ghost__');
    expect(result?.fallbackToDefault).toBe(true);
  });

  it('未知 mode（direct 等）仍返回 null', () => {
    expect(
      normalizeRoutingResolvedPayload({ mode: 'direct', agentId: 'a', agentName: 'n', reason: 'r', score: 1 }),
    ).toBeNull();
  });
});

describe('normalizeModelDecisionPayload', () => {
  const base = {
    requestedProvider: 'kimi',
    requestedModel: 'k2',
    resolvedProvider: 'deepseek',
    resolvedModel: 'ds',
    reason: 'user-selected',
    billingMode: 'plan',
  };

  it('非对象返回 null', () => {
    expect(normalizeModelDecisionPayload(undefined)).toBeNull();
  });

  it('缺必填或非法枚举返回 null', () => {
    expect(normalizeModelDecisionPayload({ ...base, reason: 'bogus' })).toBeNull();
    expect(normalizeModelDecisionPayload({ ...base, billingMode: 'bogus' })).toBeNull();
    const { requestedModel: _omit, ...missing } = base;
    expect(normalizeModelDecisionPayload(missing)).toBeNull();
  });

  it('最小合法 payload，role / fallbackFrom 缺省为 null', () => {
    expect(normalizeModelDecisionPayload(base)).toMatchObject({
      requestedProvider: 'kimi',
      resolvedModel: 'ds',
      reason: 'user-selected',
      billingMode: 'plan',
      role: null,
      fallbackFrom: null,
    });
  });

  it('完整嵌套 payload 驱动所有子 normalizer', () => {
    const result = normalizeModelDecisionPayload({
      ...base,
      role: 'main',
      fallbackFrom: 'kimi',
      turnId: 't',
      timestamp: 100,
      strategySummary: 'summary',
      complexityScore: 0.5,
      taskClass: 'coding',
      costPolicy: 'save-cost',
      speedPolicy: 'fast-path',
      toolPolicy: 'runtime-checked',
      capabilityNeeds: ['vision', 'code', 'bogus'],
      providerHealthSnapshot: {
        provider: 'deepseek',
        status: 'healthy',
        sampledAt: 1,
        latencyP50: 10,
        latencyP95: 20,
        errorRate: 0.01,
        lastSuccessAt: 2,
        lastErrorAt: 3,
        consecutiveErrors: 0,
      },
      providerIdentity: {
        provider: 'deepseek',
        displayName: 'DeepSeek',
        sourceLabel: 'cloud',
        protocol: 'openai',
        transportLabel: 'https',
        endpoint: 'https://api',
      },
      externalEngine: {
        kind: 'codex_cli',
        label: 'Codex',
        installState: 'installed',
        runtimeState: 'ready',
        executable: true,
        capabilities: ['execute', 'stream_events', 'bogus'],
        model: 'gpt',
        command: 'codex',
        version: '1.0',
        reliability: {
          cliStatus: 'available',
          authState: 'authenticated',
          quotaState: 'available',
          streamingMode: 'stream_json',
          toolSupport: 'workspace_tools',
          transcriptMode: 'clean_stream_json',
          partialMessages: true,
          mcpBridge: false,
          notes: ['ready', ''],
        },
        failure: {
          category: 'auth',
          reason: 'expired',
          message: 'token expired',
          suggestion: 'relogin',
          retryable: true,
          occurredAt: 5,
          statusCode: 401,
          exitCode: null,
          reliability: { authState: 'needs_login' },
        },
      },
      toolStrategy: {
        visibleToolCount: 5,
        mcpToolCount: 2,
        programmaticToolCalling: 'available',
        programmaticToolCount: 3,
        toolNamesPreview: ['read', ''],
        mcpServerIds: ['srv1'],
        tokenSavings: {
          status: 'provider-reported',
          savedTokens: 100,
          detail: 'saved',
          measurement: {
            savingsSource: 'provider-reported',
            usageSource: 'model-response-usage',
            providerReportedSavings: true,
          },
          providerUsage: {
            source: 'model-response-usage',
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
          },
          basis: {
            source: 'tool-spec-local-estimate',
            toolCount: 5,
            previewToolCount: 3,
            fields: ['name', 'description', 'bogus'],
          },
          providerReport: {
            source: 'provider-reported',
            savedTokens: 50,
          },
        },
      },
    });

    expect(result).toMatchObject({
      role: 'main',
      fallbackFrom: 'kimi',
      turnId: 't',
      timestamp: 100,
      strategySummary: 'summary',
      complexityScore: 0.5,
      taskClass: 'coding',
      costPolicy: 'save-cost',
      speedPolicy: 'fast-path',
      toolPolicy: 'runtime-checked',
      capabilityNeeds: ['vision', 'code'],
    });
    expect(result?.providerHealthSnapshot).toMatchObject({ provider: 'deepseek', status: 'healthy', latencyP95: 20 });
    expect(result?.providerIdentity).toMatchObject({ protocol: 'openai', endpoint: 'https://api' });
    expect(result?.externalEngine).toMatchObject({ kind: 'codex_cli', capabilities: ['execute', 'stream_events'] });
    expect(result?.externalEngine?.reliability).toMatchObject({ cliStatus: 'available', notes: ['ready'] });
    expect(result?.externalEngine?.failure).toMatchObject({ category: 'auth', exitCode: null, retryable: true });
    expect(result?.externalEngine?.failure?.reliability).toMatchObject({ authState: 'needs_login' });
    expect(result?.toolStrategy).toMatchObject({ visibleToolCount: 5, programmaticToolCalling: 'available' });
    expect(result?.toolStrategy?.tokenSavings).toMatchObject({
      status: 'provider-reported',
      measurement: { savingsSource: 'provider-reported', providerReportedSavings: true },
      providerUsage: { inputTokens: 10, totalTokens: 30 },
      basis: { toolCount: 5, fields: ['name', 'description'] },
      providerReport: { savedTokens: 50 },
    });
  });

  it('子结构非法时整体被丢弃但主 payload 仍合法', () => {
    const result = normalizeModelDecisionPayload({
      ...base,
      providerHealthSnapshot: { provider: 'p' }, // 缺 status/sampledAt
      externalEngine: { kind: 'codex_cli' }, // 缺必填
      toolStrategy: { visibleToolCount: 1 }, // 缺必填
      capabilityNeeds: 'not-array',
    });
    expect(result).toMatchObject({ requestedProvider: 'kimi' });
    expect(result?.providerHealthSnapshot).toBeUndefined();
    expect(result?.externalEngine).toBeUndefined();
    expect(result?.toolStrategy).toBeUndefined();
    expect(result?.capabilityNeeds).toBeUndefined();
  });
});

describe('normalizeModelFallbackPayload', () => {
  it('缺 reason/from/to 返回 null', () => {
    expect(normalizeModelFallbackPayload({ reason: 'r', from: 'a' })).toBeNull();
    expect(normalizeModelFallbackPayload(null)).toBeNull();
  });

  it('最小合法 payload', () => {
    expect(normalizeModelFallbackPayload({ reason: 'timeout', from: 'a', to: 'b' })).toEqual({
      reason: 'timeout',
      from: 'a',
      to: 'b',
    });
  });

  it('完整 payload 驱动 trace steps / toolPolicy / identities', () => {
    const result = normalizeModelFallbackPayload({
      reason: 'quota',
      from: 'kimi',
      to: 'deepseek',
      category: 'quota',
      strategy: 'adaptive-provider-fallback',
      tried: [
        { provider: 'kimi', status: 'tried', reason: 'rate', model: 'k2', category: 'quota', detail: 'd', providerIdentity: { provider: 'kimi' } },
        { provider: 'x' }, // 非法 → 丢弃
      ],
      skipped: [{ provider: 'glm', status: 'skipped', reason: 'unconfigured' }],
      toolPolicy: {
        status: 'disabled',
        reason: 'fallback_model_without_tool_support',
        originalToolCount: 5,
        effectiveToolCount: 0,
        disabledToolNames: ['read', ''],
        detail: 'no tools',
      },
      fromIdentity: { provider: 'kimi', displayName: 'Kimi' },
      toIdentity: { provider: 'deepseek' },
    });
    expect(result).toMatchObject({
      reason: 'quota',
      from: 'kimi',
      to: 'deepseek',
      category: 'quota',
      strategy: 'adaptive-provider-fallback',
    });
    expect(result?.tried).toHaveLength(1);
    expect(result?.tried?.[0]).toMatchObject({ provider: 'kimi', providerIdentity: { provider: 'kimi' } });
    expect(result?.skipped).toHaveLength(1);
    expect(result?.toolPolicy).toMatchObject({ status: 'disabled', originalToolCount: 5, disabledToolNames: ['read'] });
    expect(result?.fromIdentity).toMatchObject({ displayName: 'Kimi' });
    expect(result?.toIdentity).toMatchObject({ provider: 'deepseek' });
  });

  it('非法 strategy 被剔除，非法 toolPolicy 被丢弃', () => {
    const result = normalizeModelFallbackPayload({
      reason: 'r',
      from: 'a',
      to: 'b',
      strategy: 'not-a-strategy',
      toolPolicy: { status: 'enabled' }, // status 非 disabled
    });
    expect(result).toEqual({ reason: 'r', from: 'a', to: 'b' });
  });
});

describe('normalizeHookTriggerData', () => {
  const valid = {
    timestamp: 1,
    event: 'PreToolUse',
    action: 'allow' as const,
    durationMs: 12,
    hookCount: 2,
  };

  it('非对象返回 null', () => {
    expect(normalizeHookTriggerData(null)).toBeNull();
    expect(normalizeHookTriggerData('x')).toBeNull();
  });

  it('缺必填或类型错误返回 null', () => {
    expect(normalizeHookTriggerData({ ...valid, timestamp: 'x' })).toBeNull();
    expect(normalizeHookTriggerData({ ...valid, action: 'maybe' })).toBeNull();
    expect(normalizeHookTriggerData({ ...valid, hookCount: '2' })).toBeNull();
  });

  it('最小合法：sources 默认空数组，hookType 默认 observer', () => {
    expect(normalizeHookTriggerData(valid)).toEqual({
      timestamp: 1,
      event: 'PreToolUse',
      action: 'allow',
      durationMs: 12,
      hookCount: 2,
      modified: false,
      sources: [],
      hookType: 'observer',
    });
  });

  it('完整字段：过滤非法 source，保留 decision hookType 与可选字段', () => {
    expect(
      normalizeHookTriggerData({
        ...valid,
        action: 'block',
        modified: true,
        sources: ['global', 'project', 'bogus'],
        hookType: 'decision',
        errorCount: 1,
        message: 'blocked',
        sessionId: 's',
        turnId: 't',
        toolName: 'Bash',
        matcher: '*',
      }),
    ).toEqual({
      timestamp: 1,
      event: 'PreToolUse',
      action: 'block',
      durationMs: 12,
      hookCount: 2,
      modified: true,
      sources: ['global', 'project'],
      hookType: 'decision',
      errorCount: 1,
      message: 'blocked',
      sessionId: 's',
      turnId: 't',
      toolName: 'Bash',
      matcher: '*',
    });
  });
});
