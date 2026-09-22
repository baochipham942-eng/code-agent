// ============================================================================
// InferenceCache computeKey — key 内容语义（N-INFERCACHE-KEYDRIFT）
// 末 3 条消息 + provider/model 之外的输入差异必须产出不同 key；
// 完全相同的请求必须产出相同 key（保护原命中功能）。
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { InferenceOptions, ModelMessage } from '../../../src/host/model/types';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { InferenceCache } from '../../../src/host/model/inferenceCache';

const baseConfig: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 2048,
};

// 6 条消息：末 3 条是 [user1, assistant1, user2]，system 与 user0 都在旧 key 的窗口之外
const baseMessages: ModelMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: '第一轮问题' },
  { role: 'assistant', content: '第一轮回答' },
  { role: 'user', content: '第二轮问题' },
  { role: 'assistant', content: '第二轮回答' },
  { role: 'user', content: '最后的问题' },
];

const baseTools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: '查询城市天气',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    outputSchema: { type: 'object' },
    requiresPermission: false,
    permissionLevel: 'read',
  },
];

function computeKey(
  cache: InferenceCache,
  messages: ModelMessage[] = baseMessages,
  config: ModelConfig = baseConfig,
  tools: ToolDefinition[] = baseTools,
  options?: InferenceOptions,
): string {
  return cache.computeKey(messages, config, tools, options);
}

describe('InferenceCache.computeKey key 内容', () => {
  const cache = new InferenceCache();

  it('完全相同的请求产出相同 key（含键序不同的等价序列化）', () => {
    const once = computeKey(cache);
    const again = computeKey(new InferenceCache(), structuredClone(baseMessages), structuredClone(baseConfig), structuredClone(baseTools));
    expect(again).toBe(once);
  });

  it('相同内容不同键序的 tool schema / 消息 content 产出相同 key（稳定序列化）', () => {
    const reorderedTools: ToolDefinition[] = [
      {
        ...baseTools[0],
        inputSchema: { required: ['city'], properties: { city: { type: 'string' } }, type: 'object' },
      },
    ];
    expect(computeKey(cache, baseMessages, baseConfig, reorderedTools)).toBe(computeKey(cache, baseMessages, baseConfig, baseTools));

    const reorderedContentMessages: ModelMessage[] = [
      ...baseMessages.slice(0, 5),
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: '看图' },
        ],
      },
    ];
    const sameContentDifferentKeyOrder: ModelMessage[] = [
      ...baseMessages.slice(0, 5),
      {
        role: 'user',
        content: [
          { source: { data: 'abc', media_type: 'image/png', type: 'base64' }, type: 'image' },
          { text: '看图', type: 'text' },
        ],
      },
    ];
    expect(
      computeKey(cache, sameContentDifferentKeyOrder, baseConfig, [])
    ).toBe(computeKey(cache, reorderedContentMessages, baseConfig, []));
  });

  it('末 3 条消息相同但 system prompt 不同 → 不同 key', () => {
    const differentSystem: ModelMessage[] = [
      { role: 'system', content: 'You are a strict code reviewer.' },
      ...baseMessages.slice(1),
    ];
    expect(computeKey(cache, differentSystem)).not.toBe(computeKey(cache));
  });

  it('末 3 条消息相同但更早的历史不同 → 不同 key', () => {
    const differentHistory: ModelMessage[] = [
      baseMessages[0],
      { role: 'user', content: '另一个第一轮问题' },
      ...baseMessages.slice(2),
    ];
    expect(computeKey(cache, differentHistory)).not.toBe(computeKey(cache));
  });

  it('tools 不同（name / description / schema 变化）→ 不同 key', () => {
    const differentName: ToolDefinition[] = [{ ...baseTools[0], name: 'get_time' }];
    const differentDescription: ToolDefinition[] = [{ ...baseTools[0], description: '查询城市时间' }];
    const differentSchema: ToolDefinition[] = [
      { ...baseTools[0], inputSchema: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string' } } } },
    ];
    expect(computeKey(cache, baseMessages, baseConfig, differentName)).not.toBe(computeKey(cache));
    expect(computeKey(cache, baseMessages, baseConfig, differentDescription)).not.toBe(computeKey(cache));
    expect(computeKey(cache, baseMessages, baseConfig, differentSchema)).not.toBe(computeKey(cache));
  });

  it('temperature / maxTokens / responseFormat / thinkingBudget 不同 → 不同 key', () => {
    expect(computeKey(cache, baseMessages, { ...baseConfig, temperature: 0.2 })).not.toBe(computeKey(cache));
    expect(computeKey(cache, baseMessages, { ...baseConfig, maxTokens: 4096 })).not.toBe(computeKey(cache));
    expect(
      computeKey(cache, baseMessages, {
        ...baseConfig,
        responseFormat: { type: 'json_object' },
      })
    ).not.toBe(computeKey(cache));
    expect(computeKey(cache, baseMessages, { ...baseConfig, thinkingBudget: 8192 })).not.toBe(computeKey(cache));
  });

  it('reasoningEffort 取 options 优先于 config 的有效值（与 provider 折叠一致）', () => {
    // config 写 low、options 不写 与 两者互换 → 有效值相同 → 同 key
    const fromConfig = computeKey(cache, baseMessages, { ...baseConfig, reasoningEffort: 'low' }, baseTools, undefined);
    const fromOptions = computeKey(cache, baseMessages, baseConfig, baseTools, { reasoningEffort: 'low' });
    expect(fromOptions).toBe(fromConfig);

    // options 覆盖 config 时按覆盖后的有效值区分
    const lowThenHigh = computeKey(
      cache,
      baseMessages,
      { ...baseConfig, reasoningEffort: 'low' },
      baseTools,
      { reasoningEffort: 'high' },
    );
    expect(lowThenHigh).not.toBe(fromConfig);
  });

  it('searchEnabled / toolChoice 等 options 开关不同 → 不同 key；语义等价的缺省与 true 同 key', () => {
    const searchOff = computeKey(cache, baseMessages, baseConfig, baseTools, { searchEnabled: false });
    const searchDefault = computeKey(cache, baseMessages, baseConfig, baseTools, undefined);
    const searchOn = computeKey(cache, baseMessages, baseConfig, baseTools, { searchEnabled: true });
    expect(searchOff).not.toBe(searchDefault);
    expect(searchOn).toBe(searchDefault);

    const forcedTool = computeKey(cache, baseMessages, baseConfig, baseTools, { toolChoice: { type: 'tool', toolName: 'get_weather' } });
    expect(forcedTool).not.toBe(searchDefault);
  });

  it('provider / model 不同 → 不同 key（原有行为保留）', () => {
    expect(computeKey(cache, baseMessages, { ...baseConfig, provider: 'moonshot' })).not.toBe(computeKey(cache));
    expect(computeKey(cache, baseMessages, { ...baseConfig, model: 'deepseek-reasoner' })).not.toBe(computeKey(cache));
  });

  it('apiKey 不同 → 同 key（凭据不属于请求语义）', () => {
    expect(computeKey(cache, baseMessages, { ...baseConfig, apiKey: 'sk-other' })).toBe(computeKey(cache));
  });

  it('cacheScopeId 与 cacheRetention 不改变 cache bucket key', () => {
    const scoped: InferenceOptions = { cacheRetention: 'none', cacheScopeId: 'judge' };
    expect(computeKey(cache, baseMessages, baseConfig, baseTools, scoped)).toBe(computeKey(cache));
  });
});

describe('InferenceCache get/set 命中', () => {
  it('完全相同的非流式请求第二次命中缓存（保护原有功能）', () => {
    const cache = new InferenceCache();
    const response = { type: 'text' as const, content: 'cached answer', finishReason: 'stop' };
    const key = cache.computeKey(baseMessages, baseConfig, baseTools, undefined);
    cache.set(key, response);
    expect(cache.get(key)).toBe(response);

    // 内容等价但对象重新构造（不同键序）的同一请求也命中
    const reorderedConfig = { maxTokens: 2048, model: 'deepseek-chat', provider: 'deepseek', temperature: 0.7 } as ModelConfig;
    const equivalentKey = cache.computeKey(baseMessages, reorderedConfig, baseTools, undefined);
    expect(cache.get(equivalentKey)).toBe(response);
  });

  it('system prompt 不同的请求不命中', () => {
    const cache = new InferenceCache();
    const response = { type: 'text' as const, content: 'cached answer', finishReason: 'stop' };
    cache.set(cache.computeKey(baseMessages, baseConfig, baseTools, undefined), response);
    const differentSystem: ModelMessage[] = [
      { role: 'system', content: '另一个系统提示' },
      ...baseMessages.slice(1),
    ];
    expect(cache.get(cache.computeKey(differentSystem, baseConfig, baseTools, undefined))).toBeNull();
  });
});
