// ============================================================================
// AdaptiveRouter — selectFallback tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveRouter } from '../../../src/host/model/adaptiveRouter';
import type { FallbackContext } from '../../../src/host/model/adaptiveRouter';

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
