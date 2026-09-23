// ============================================================================
// InferenceCache computeKey — key 内容语义（N-INFERCACHE-KEYDRIFT）
// 末 3 条消息 + provider/model 之外的输入差异必须产出不同 key；
// 完全相同的请求必须产出相同 key（保护原命中功能）。
// ============================================================================

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';
import type { InferenceOptions, ModelMessage } from '../../../src/host/model/types';
import { ClaudeProvider } from '../../../src/host/model/providers/claudeProvider';
import { electronFetch } from '../../../src/host/model/providers/shared';
import {
  clearSessionCacheHits,
  isObservedCacheHit,
  noteStagnationFingerprint,
  recordSessionCacheHit,
} from '../../../src/host/model/cacheHitObservation';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/model/providers/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/model/providers/shared')>(
    '../../../src/host/model/providers/shared',
  );
  return {
    ...actual,
    electronFetch: vi.fn(),
  };
});

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

const mockElectronFetch = vi.mocked(electronFetch);

function cacheControlledPrefix(body: Record<string, unknown>): string | null {
  const raw = JSON.stringify(body);
  if (!raw.includes('cache_control')) return null;
  return JSON.stringify({ system: body.system, tools: body.tools });
}

class PrefixSlot {
  private stored: string | null = null;

  observe(body: Record<string, unknown>): 'hit' | 'miss' | 'bypass' {
    const prefix = cacheControlledPrefix(body);
    if (prefix === null) return 'bypass';
    if (this.stored === prefix) return 'hit';
    this.stored = prefix;
    return 'miss';
  }
}

describe('prefix stability after side-path calls', () => {
  const tool: ToolDefinition = {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
  };

  beforeEach(() => {
    mockElectronFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 18 },
      }),
    } as never);
  });

  async function captureBody(messages: ModelMessage[], options?: InferenceOptions) {
    mockElectronFetch.mockClear();
    await new ClaudeProvider().inference(
      messages,
      [tool],
      { provider: 'claude', model: 'claude-sonnet-4-6', apiKey: 'test-key' },
      undefined,
      undefined,
      options,
    );
    return JSON.parse(String(mockElectronFetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
  }

  it('hits the same cache prefix when only the user turn changes', async () => {
    const slot = new PrefixSlot();
    const first = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'turn one' },
    ]);
    const second = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'turn two' },
    ]);
    expect(slot.observe(first)).toBe('miss');
    expect(slot.observe(second)).toBe('hit');
  });

  it('keeps the main-session prefix hit after a cacheRetention none side path', async () => {
    const slot = new PrefixSlot();
    const main = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'continue the task' },
    ]);
    const sidePath = await captureBody(
      [{ role: 'user', content: 'Summarize a different conversation for compaction.' }],
      { cacheRetention: 'none', cacheScopeId: 'compact-summary' },
    );
    const after = await captureBody([
      { role: 'system', content: 'You are Agent Neo. Stable prefix.' },
      { role: 'user', content: 'continue the task' },
    ]);
    expect(JSON.stringify(sidePath)).not.toContain('cache_control');
    expect(slot.observe(main)).toBe('miss');
    expect(slot.observe(sidePath)).toBe('bypass');
    expect(slot.observe(after)).toBe('hit');
  });
});

describe('cache hit effective / idle split', () => {
  it('does not treat cacheRead>0 as the only hit, and an unchanged fingerprint is idle', () => {
    expect(isObservedCacheHit({ cacheReadTokens: 0 })).toBe(false);
    expect(isObservedCacheHit({ cacheReadTokens: 0, inferenceCacheHit: true })).toBe(true);
    expect(isObservedCacheHit({ cacheReadTokens: 0, toolCacheHit: true })).toBe(true);
    expect(isObservedCacheHit({ cacheReadTokens: 12 })).toBe(true);
    const untouched = `hit-untouched-${Date.now()}`;
    expect(recordSessionCacheHit(untouched).kind).toBe('idle');
    const repeated = `hit-repeated-${Date.now()}`;
    recordSessionCacheHit(repeated, 'fp-a');
    expect(recordSessionCacheHit(repeated, 'fp-a').kind).toBe('idle');
    expect(recordSessionCacheHit(repeated, 'fp-b').kind).toBe('effective');
  });

  it('counts a tool-cache replay with the same fingerprint as idle', () => {
    const sessionId = `hit-${Date.now()}-same`;
    noteStagnationFingerprint(sessionId, 'fp-same');
    const first = recordSessionCacheHit(sessionId, 'fp-same');
    const second = recordSessionCacheHit(sessionId, 'fp-same');
    expect(first.kind).toBe('effective');
    expect(second.kind).toBe('idle');
  });

  it('counts a later hit as effective after the stagnation fingerprint changes', () => {
    const sessionId = `hit-${Date.now()}-change`;
    recordSessionCacheHit(sessionId, 'fp-1');
    noteStagnationFingerprint(sessionId, 'fp-2');
    expect(recordSessionCacheHit(sessionId).kind).toBe('effective');
  });

  it('clears session state and bounds retained sessions with an LRU cap', () => {
    const prefix = `hit-lru-${Date.now()}`;
    const sessionIds = Array.from({ length: 256 }, (_, index) => `${prefix}-${index}`);
    for (const sessionId of sessionIds) recordSessionCacheHit(sessionId, 'same');
    recordSessionCacheHit(sessionIds[0], 'same');
    recordSessionCacheHit(`${prefix}-overflow`, 'same');

    expect(recordSessionCacheHit(sessionIds[0], 'same').kind).toBe('idle');
    expect(recordSessionCacheHit(sessionIds[1], 'same').kind).toBe('effective');
    clearSessionCacheHits(sessionIds[0]);
    expect(recordSessionCacheHit(sessionIds[0], 'same').kind).toBe('effective');
  });
});
