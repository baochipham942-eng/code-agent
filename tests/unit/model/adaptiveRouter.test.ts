// ============================================================================
// AdaptiveRouter — selectFallback tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveRouter } from '../../../src/host/model/adaptiveRouter';
import type { FallbackContext } from '../../../src/host/model/adaptiveRouter';
import type { JevSystemOneCall } from '../../../src/shared/constants/jevQuestions';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeContext(overrides: Partial<FallbackContext> = {}): FallbackContext {
  return {
    reason: 'rate_limit',
    currentModel: 'kimi-k2.5',
    currentProvider: 'moonshot',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('AdaptiveRouter.selectFallback', () => {
  let router: AdaptiveRouter;

  beforeEach(() => {
    router = new AdaptiveRouter();
  });

  // --- auth ---

  it('returns null for auth reason — cannot recover by switching', () => {
    const result = router.selectFallback(makeContext({ reason: 'auth' }));
    expect(result).toBeNull();
  });

  // --- rate_limit ---

  it('returns a different provider for rate_limit', () => {
    const result = router.selectFallback(makeContext({ reason: 'rate_limit', currentProvider: 'moonshot' }));
    expect(result).not.toBeNull();
    expect(result!.provider).not.toBe('moonshot');
  });

  it('rate_limit result skips current provider', () => {
    const result = router.selectFallback(makeContext({ reason: 'rate_limit', currentProvider: 'deepseek', currentModel: 'deepseek-chat' }));
    expect(result).not.toBeNull();
    expect(result!.provider).not.toBe('deepseek');
  });

  it('rate_limit result includes contextWindow and reason fields', () => {
    const result = router.selectFallback(makeContext({ reason: 'rate_limit' }));
    expect(result).not.toBeNull();
    expect(typeof result!.contextWindow).toBe('number');
    expect(result!.contextWindow).toBeGreaterThan(0);
    expect(typeof result!.reason).toBe('string');
    expect(result!.reason.length).toBeGreaterThan(0);
  });

  it('rate_limit returns null when provider has no fallback chain entry', () => {
    // Use a provider not in PROVIDER_FALLBACK_CHAIN
    const result = router.selectFallback(makeContext({ reason: 'rate_limit', currentProvider: 'local', currentModel: 'qwen2.5-coder:7b' }));
    expect(result).toBeNull();
  });

  // --- unavailable ---

  it('unavailable reason walks fallback chain and returns different provider', () => {
    const result = router.selectFallback(makeContext({ reason: 'unavailable', currentProvider: 'moonshot' }));
    expect(result).not.toBeNull();
    expect(result!.provider).not.toBe('moonshot');
  });

  it('unavailable result skips current provider', () => {
    const result = router.selectFallback(makeContext({ reason: 'unavailable', currentProvider: 'deepseek', currentModel: 'deepseek-chat' }));
    expect(result).not.toBeNull();
    expect(result!.provider).not.toBe('deepseek');
  });

  // --- network ---

  it('network reason walks fallback chain and returns different provider', () => {
    const result = router.selectFallback(makeContext({ reason: 'network', currentProvider: 'moonshot' }));
    expect(result).not.toBeNull();
    expect(result!.provider).not.toBe('moonshot');
  });

  // --- context_overflow ---

  it('context_overflow returns a model with a larger context window', () => {
    // deepseek-chat has 64_000; moonshot kimi-k2.5 has 256_000 — so overflow from deepseek should find kimi
    const result = router.selectFallback(makeContext({
      reason: 'context_overflow',
      currentProvider: 'deepseek',
      currentModel: 'deepseek-chat',
    }));
    expect(result).not.toBeNull();
    expect(result!.contextWindow).toBeGreaterThan(64_000);
  });

  it('context_overflow result skips current provider', () => {
    const result = router.selectFallback(makeContext({
      reason: 'context_overflow',
      currentProvider: 'deepseek',
      currentModel: 'deepseek-chat',
    }));
    expect(result).not.toBeNull();
    expect(result!.provider).not.toBe('deepseek');
  });

  it('context_overflow reason field explains the context comparison', () => {
    const result = router.selectFallback(makeContext({
      reason: 'context_overflow',
      currentProvider: 'deepseek',
      currentModel: 'deepseek-chat',
    }));
    expect(result).not.toBeNull();
    expect(result!.reason).toMatch(/larger context/);
  });

  it('context_overflow returns null when no model has a larger window than current', () => {
    // Grok 4.1 Fast has a 2M window, currently the largest in CONTEXT_WINDOWS.
    const result = router.selectFallback(makeContext({
      reason: 'context_overflow',
      currentProvider: 'grok',
      currentModel: 'grok-4-1-fast-reasoning',
    }));
    expect(result).toBeNull();
  });
});

describe('AdaptiveRouter Jev intent router', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('is default off and preserves the heuristic without calling Jev', async () => {
    const router = new AdaptiveRouter();
    const systemOne = vi.fn() as unknown as JevSystemOneCall;
    const result = await router.estimateComplexityWithJev([{ role: 'user', content: 'hello' }], systemOne);
    expect(result.level).toBe('simple');
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('synthesizes intent and complexity, and keeps ambiguous requests out of the simple tier', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = vi.fn(async () => ({
      intent: { choice: 'artifact', confidence: 0.92 },
      complexity: { choice: '1', confidence: 0.91 },
      needs_clarification: { noul: 0.95 },
      destructive_intent: { noul: 0.05 },
    })) as unknown as JevSystemOneCall;
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'update the previous report' }],
      systemOne,
    );
    expect(result.level).toBe('complex');
    expect(result.suggestClarification).toBe(true);
    expect(result.signals).toContain('jev_intent:artifact');
    expect(result.signals).toContain('needs_clarification:0.95');
  });

  it('does not set suggestClarification below the centralized threshold', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = vi.fn(async () => ({
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: '0', confidence: 0.9 },
      needs_clarification: { noul: 0.89 },
      destructive_intent: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'hi' }],
      systemOne,
    );
    expect(result.level).toBe('simple');
    expect(result.suggestClarification).toBeUndefined();
  });

  it('caches the Jev estimate per last user message within a turn', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = vi.fn(async () => ({
      intent: { choice: 'coding', confidence: 0.9 },
      complexity: { choice: '1', confidence: 0.9 },
      needs_clarification: { noul: 0.1 },
      destructive_intent: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const router = new AdaptiveRouter();
    const first = await router.estimateComplexityWithJev([{ role: 'user', content: 'fix the parser bug' }], systemOne);
    // Loop iterations append tool messages; the last user message is unchanged.
    const second = await router.estimateComplexityWithJev(
      [
        { role: 'user', content: 'fix the parser bug' },
        { role: 'assistant', content: 'working on it' },
      ],
      systemOne,
    );
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    await router.estimateComplexityWithJev([{ role: 'user', content: 'a different request' }], systemOne);
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  it('fails open: heuristic fallbacks are not cached, the next iteration retries Jev', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const router = new AdaptiveRouter();
    const lowConfidence = vi.fn(async () => ({
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: '0', confidence: 0.49 },
      needs_clarification: { noul: 0 },
      destructive_intent: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const fallback = await router.estimateComplexityWithJev(
      [{ role: 'user', content: 'hello' }],
      lowConfidence,
    );
    expect(fallback.signals).toContain('short_message');
    expect(fallback.suggestClarification).toBeUndefined();

    const healthy = vi.fn(async () => ({
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: '0', confidence: 0.9 },
      needs_clarification: { noul: 0 },
      destructive_intent: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const retried = await router.estimateComplexityWithJev(
      [{ role: 'user', content: 'hello' }],
      healthy,
    );
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(retried.signals).toContain('jev_intent:chat');
  });

  it('does not downgrade on low confidence and fails back to heuristic on provider errors', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const lowConfidence = vi.fn(async () => ({
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: '0', confidence: 0.49 },
      needs_clarification: { noul: 0 },
      destructive_intent: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const low = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'this is a long request that should not be downgraded by an uncertain classifier because it has a file.json reference' }],
      lowConfidence,
    );
    expect(low.signals).not.toContain('jev_intent:chat');

    const failing = vi.fn(async () => { throw new Error('jev down'); }) as unknown as JevSystemOneCall;
    const fallback = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'hello' }],
      failing,
    );
    expect(fallback.signals).toContain('short_message');
  });

  it('keeps image requests out of the free text-only tier even when Jev says simple', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = vi.fn(async () => ({
      intent: { choice: 'vision', confidence: 0.95 },
      complexity: { choice: '0', confidence: 0.95 },
      needs_clarification: { noul: 0 },
      destructive_intent: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'redacted' } }] }],
      systemOne,
    );
    expect(result.level).toBe('complex');
    expect(result.signals).toContain('has_image');
  });
});

// --------------------------------------------------------------------------
// selectModel — CLI_MODE / WEB_MODE 守卫
// --------------------------------------------------------------------------

describe('AdaptiveRouter.selectModel env guards', () => {
  let router: AdaptiveRouter;
  const defaultConfig = {
    provider: 'custom-commonstack-claude',
    model: 'anthropic/claude-opus-4-8',
  } as Parameters<AdaptiveRouter['selectModel']>[1];
  const simpleComplexity = { level: 'simple' as const, score: 20, signals: ['short_message'] };

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ADAPTIVE_ROUTER_DISABLED', 'CODE_AGENT_CLI_MODE', 'CODE_AGENT_WEB_MODE'];

  beforeEach(() => {
    router = new AdaptiveRouter();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('routes simple task to free model with no env flags set', () => {
    const result = router.selectModel(simpleComplexity, defaultConfig);
    expect(result.provider).not.toBe(defaultConfig.provider);
  });

  it('disables routing in pure CLI mode (CLI_MODE=true, WEB_MODE unset)', () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    const result = router.selectModel(simpleComplexity, defaultConfig);
    expect(result).toEqual(defaultConfig);
  });

  it('keeps routing in web/desktop mode (CLI_MODE=true + WEB_MODE=true)', () => {
    // webServer 同时设置两个变量（keytar 守卫），自动模式必须仍然生效
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';
    const result = router.selectModel(simpleComplexity, defaultConfig);
    expect(result.provider).not.toBe(defaultConfig.provider);
  });

  it('ADAPTIVE_ROUTER_DISABLED=true always disables routing, even in web mode', () => {
    process.env.ADAPTIVE_ROUTER_DISABLED = 'true';
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';
    const result = router.selectModel(simpleComplexity, defaultConfig);
    expect(result).toEqual(defaultConfig);
  });

  it('does not route moderate/complex tasks to free model regardless of env', () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    const moderate = { level: 'moderate' as const, score: 50, signals: [] };
    const result = router.selectModel(moderate, defaultConfig);
    expect(result.provider).toBe(defaultConfig.provider);
  });
});

describe('withClarificationHint（澄清提示组装，纯函数）', () => {
  it('首条为 string 型 system 时并入其末尾，不新增第二条 system', async () => {
    const { withClarificationHint } = await import('../../../src/host/model/adaptiveRouter');
    const messages = [
      { role: 'system', content: 'You are Neo.' },
      { role: 'user', content: 'update the previous report' },
    ];
    const hinted = withClarificationHint(messages);
    expect(hinted.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(hinted[0].content).toContain('You are Neo.');
    expect(hinted[0].content).toContain('clarifying question');
    // 不污染调用方的消息数组
    expect(messages[0].content).toBe('You are Neo.');
    expect(messages).toHaveLength(2);
  });

  it('没有 system 或首条非纯文本时才追加新 system 消息', async () => {
    const { withClarificationHint } = await import('../../../src/host/model/adaptiveRouter');
    const hinted = withClarificationHint([{ role: 'user', content: 'hi' }]);
    expect(hinted).toHaveLength(2);
    expect(hinted[1].role).toBe('system');
    expect(hinted[1].content).toContain('clarifying question');
  });
});
