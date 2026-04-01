// ============================================================================
// AdaptiveRouter — selectFallback tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveRouter } from '../../../src/main/model/adaptiveRouter';
import type { FallbackContext } from '../../../src/main/model/adaptiveRouter';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('../../../src/main/services/infra/logger', () => ({
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
    // kimi-k2.5 has 256_000 — largest in CONTEXT_WINDOWS; no model should be larger
    const result = router.selectFallback(makeContext({
      reason: 'context_overflow',
      currentProvider: 'moonshot',
      currentModel: 'kimi-k2.5',
    }));
    expect(result).toBeNull();
  });
});
