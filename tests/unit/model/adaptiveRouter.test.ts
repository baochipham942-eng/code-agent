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

  /** 新契约默认答案：命名键 complexity + needs_vision/high_stakes 两 Noul。 */
  function jevAnswers(overrides: Record<string, unknown> = {}) {
    return {
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: 'simple', confidence: 0.9 },
      needs_clarification: { noul: 0 },
      needs_vision: { noul: 0 },
      high_stakes: { noul: 0 },
      ...overrides,
    };
  }
  const mockSystemOne = (overrides: Record<string, unknown> = {}) =>
    vi.fn(async () => jevAnswers(overrides)) as unknown as JevSystemOneCall;

  it('is default on (N-JEV-DEFAULT-ON): unset flag routes through Jev', async () => {
    const systemOne = mockSystemOne();
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'hello' }],
      systemOne,
    );
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(result.signals).toContain('jev_intent:chat');
  });

  it("flag '0' is field-by-field identical to the heuristic and never calls Jev", async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '0');
    const router = new AdaptiveRouter();
    const systemOne = vi.fn() as unknown as JevSystemOneCall;
    const messages = [{ role: 'user', content: 'hello' }];
    const result = await router.estimateComplexityWithJev(messages, systemOne);
    expect(result).toEqual(router.estimateComplexity(messages));
    expect(systemOne).not.toHaveBeenCalled();
  });

  it('accepts named complexity keys and reports needs_vision/high_stakes signals', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({
      intent: { choice: 'coding', confidence: 0.92 },
      complexity: { choice: 'moderate', confidence: 0.91 },
    });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'fix the parser bug' }],
      systemOne,
    );
    expect(result.level).toBe('moderate');
    expect(result.signals).toContain('jev_intent:coding');
    expect(result.signals).toContain('jev_confidence:0.91');
    expect(result.signals).toContain('needs_vision:0.00');
    expect(result.signals).toContain('high_stakes:0.00');
  });

  it('keeps ambiguous requests out of the simple tier via suggestClarification', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({
      intent: { choice: 'artifact', confidence: 0.92 },
      needs_clarification: { noul: 0.95 },
    });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'update the previous report' }],
      systemOne,
    );
    expect(result.level).not.toBe('simple');
    expect(result.suggestClarification).toBe(true);
    expect(result.signals).toContain('jev_intent:artifact');
    expect(result.signals).toContain('needs_clarification:0.95');
  });

  it('does not set suggestClarification below the centralized threshold', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({ needs_clarification: { noul: 0.89 } });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'hi' }],
      systemOne,
    );
    expect(result.level).toBe('simple');
    expect(result.suggestClarification).toBeUndefined();
  });

  it('high_stakes ≥ 0.6 keeps the request out of the simple tier even when Jev says simple', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({ high_stakes: { noul: 0.8 } });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'rename this variable' }],
      systemOne,
    );
    expect(result.level).not.toBe('simple');
  });

  it('needs_vision ≥ 0.6 keeps the request out of the simple tier even when Jev says simple', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({ needs_vision: { noul: 0.7 } });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'what does this diagram show' }],
      systemOne,
    );
    expect(result.level).not.toBe('simple');
  });

  it('caches the Jev estimate per last user message within a turn', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({
      intent: { choice: 'coding', confidence: 0.9 },
      complexity: { choice: 'moderate', confidence: 0.9 },
      needs_clarification: { noul: 0.1 },
    });
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
    const lowConfidence = mockSystemOne({ complexity: { choice: 'simple', confidence: 0.59 } });
    const fallback = await router.estimateComplexityWithJev(
      [{ role: 'user', content: 'hello' }],
      lowConfidence,
    );
    expect(fallback.signals).toContain('short_message');
    expect(fallback.suggestClarification).toBeUndefined();

    const healthy = mockSystemOne();
    const retried = await router.estimateComplexityWithJev(
      [{ role: 'user', content: 'hello' }],
      healthy,
    );
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(retried.signals).toContain('jev_intent:chat');
  });

  it('does not downgrade on low confidence and fails back to heuristic on provider errors', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const lowConfidence = mockSystemOne({ complexity: { choice: 'simple', confidence: 0.59 } });
    const low = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: 'this is a long request that should not be downgraded by an uncertain classifier because it has a file.json reference' }],
      lowConfidence,
    );
    expect(low.signals).not.toContain('jev_intent:chat');

    const router = new AdaptiveRouter();
    const failing = vi.fn(async () => { throw new Error('jev down'); }) as unknown as JevSystemOneCall;
    const messages = [{ role: 'user', content: 'hello' }];
    const fallback = await router.estimateComplexityWithJev(messages, failing);
    // 判官抛错 ⇒ 100% 回启发式，逐字段一致
    expect(fallback).toEqual(router.estimateComplexity(messages));
    expect(fallback.signals).toContain('short_message');
  });

  it('malformed answers (missing high_stakes) fall back to the heuristic', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const malformed = vi.fn(async () => ({
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: 'simple', confidence: 0.9 },
      needs_clarification: { noul: 0 },
      needs_vision: { noul: 0 },
    })) as unknown as JevSystemOneCall;
    const router = new AdaptiveRouter();
    const messages = [{ role: 'user', content: 'hello' }];
    const result = await router.estimateComplexityWithJev(messages, malformed);
    expect(result).toEqual(router.estimateComplexity(messages));
  });

  it('rejects integer-style complexity choices from the old contract', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const oldShape = mockSystemOne({ complexity: { choice: '1', confidence: 0.9 } });
    const router = new AdaptiveRouter();
    const messages = [{ role: 'user', content: 'hello' }];
    const result = await router.estimateComplexityWithJev(messages, oldShape);
    expect(result).toEqual(router.estimateComplexity(messages));
  });

  it('keeps image requests out of the free text-only tier even when Jev says simple', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const systemOne = mockSystemOne({ complexity: { choice: 'simple', confidence: 0.95 } });
    const result = await new AdaptiveRouter().estimateComplexityWithJev(
      [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'redacted' } }] }],
      systemOne,
    );
    expect(result.level).not.toBe('simple');
    expect(result.signals).toContain('has_image');
  });
});

describe('AdaptiveRouter Jev 规则地板（独立于判官）', () => {
  beforeEach(() => vi.unstubAllEnvs());

  const alwaysSimpleZeroStakes = () =>
    vi.fn(async () => ({
      intent: { choice: 'chat', confidence: 0.9 },
      complexity: { choice: 'simple', confidence: 0.99 },
      needs_clarification: { noul: 0 },
      needs_vision: { noul: 0 },
      high_stakes: { noul: 0 },
    })) as unknown as JevSystemOneCall;

  // 删除 / 付款转账 / 对外发帖发送 三类各两条（中英文各一），mock 判官恒 simple 且 high_stakes 恒 0。
  const HIGH_RISK_PROMPTS = [
    '帮我删除临时目录下的所有文件',
    'delete all cached files under /tmp/scratch',
    '帮我付款 200 元给这个供应商',
    'transfer $300 to account 1234',
    '帮我在社区论坛发帖宣布版本发布',
    'post this announcement to the public subreddit',
  ];

  it('high-risk keyword floor: none of the six prompts route to simple whatever Jev answers', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    for (const prompt of HIGH_RISK_PROMPTS) {
      const result = await new AdaptiveRouter().estimateComplexityWithJev(
        [{ role: 'user', content: prompt }],
        alwaysSimpleZeroStakes(),
      );
      expect(result.level, `prompt: ${prompt}`).not.toBe('simple');
      expect(result.signals).toContain('high_risk_rule_floor');
    }
  });

  it('rule floor still applies when the judge throws and the router falls back to the heuristic', async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '1');
    const failing = vi.fn(async () => { throw new Error('jev down'); }) as unknown as JevSystemOneCall;
    for (const prompt of HIGH_RISK_PROMPTS) {
      const result = await new AdaptiveRouter().estimateComplexityWithJev(
        [{ role: 'user', content: prompt }],
        failing,
      );
      expect(result.level, `prompt: ${prompt}`).not.toBe('simple');
      expect(result.signals).toContain('high_risk_rule_floor');
    }
  });

  it("rule floor is inert when the switch is off ('0', zero behavior change vs heuristic)", async () => {
    vi.stubEnv('CODE_AGENT_JEV_ROUTER', '0');
    const router = new AdaptiveRouter();
    const systemOne = alwaysSimpleZeroStakes();
    for (const prompt of HIGH_RISK_PROMPTS) {
      const messages = [{ role: 'user', content: prompt }];
      const result = await router.estimateComplexityWithJev(messages, systemOne);
      expect(result).toEqual(router.estimateComplexity(messages));
    }
    expect(systemOne).not.toHaveBeenCalled();
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
