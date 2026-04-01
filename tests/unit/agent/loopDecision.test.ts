// ============================================================================
// LoopDecision Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { decideNextAction } from '../../../src/main/agent/loopDecision';
import type { LoopState, LoopDecision } from '../../../src/main/agent/loopDecision';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    stopReason: 'end_turn',
    tokenUsage: { input: 1000, output: 500 },
    maxTokens: 128_000,
    errorType: null,
    consecutiveErrors: 0,
    budgetRemaining: 1.0,
    iterationCount: 0,
    maxIterations: 20,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// 1. Hard terminators
// --------------------------------------------------------------------------

describe('decideNextAction – hard terminators', () => {
  it('budget exhausted → terminate', () => {
    const decision = decideNextAction(makeState({ budgetRemaining: 0 }));
    expect(decision.action).toBe('terminate');
    expect(decision.reason).toMatch(/budget exhausted/i);
  });

  it('budgetRemaining < 0 also terminates', () => {
    const decision = decideNextAction(makeState({ budgetRemaining: -0.1 }));
    expect(decision.action).toBe('terminate');
  });

  it('iterationCount equals maxIterations → terminate', () => {
    const decision = decideNextAction(makeState({ iterationCount: 20, maxIterations: 20 }));
    expect(decision.action).toBe('terminate');
    expect(decision.reason).toMatch(/max iterations/i);
  });

  it('iterationCount exceeds maxIterations → terminate', () => {
    const decision = decideNextAction(makeState({ iterationCount: 25, maxIterations: 20 }));
    expect(decision.action).toBe('terminate');
  });

  it('3 consecutive errors → terminate', () => {
    const decision = decideNextAction(
      makeState({ consecutiveErrors: 3, errorType: 'network' }),
    );
    expect(decision.action).toBe('terminate');
    expect(decision.reason).toMatch(/3 consecutive errors/);
  });

  it('consecutive errors > 3 also terminates', () => {
    const decision = decideNextAction(
      makeState({ consecutiveErrors: 5, errorType: 'unknown' }),
    );
    expect(decision.action).toBe('terminate');
  });

  it('hard terminators take priority over error recovery', () => {
    // budget = 0 even though errorType = 'network' (which would normally → continue)
    const decision = decideNextAction(
      makeState({ budgetRemaining: 0, errorType: 'network', consecutiveErrors: 1 }),
    );
    expect(decision.action).toBe('terminate');
  });
});

// --------------------------------------------------------------------------
// 2. Error recovery
// --------------------------------------------------------------------------

describe('decideNextAction – error recovery', () => {
  it('overflow + first occurrence → compact', () => {
    const decision = decideNextAction(
      makeState({ errorType: 'overflow', consecutiveErrors: 0 }),
    );
    expect(decision.action).toBe('compact');
  });

  it('overflow + consecutiveErrors = 1 → compact', () => {
    const decision = decideNextAction(
      makeState({ errorType: 'overflow', consecutiveErrors: 1 }),
    );
    expect(decision.action).toBe('compact');
  });

  it('overflow + consecutiveErrors = 2 → fallback (persists after compression)', () => {
    const decision = decideNextAction(
      makeState({ errorType: 'overflow', consecutiveErrors: 2 }),
    );
    expect(decision.action).toBe('fallback');
    expect(decision.reason).toMatch(/overflow persists after compression/i);
  });

  it('rate_limit → fallback', () => {
    const decision = decideNextAction(makeState({ errorType: 'rate_limit' }));
    expect(decision.action).toBe('fallback');
    expect(decision.reason).toMatch(/rate limited/i);
  });

  it('unavailable → fallback', () => {
    const decision = decideNextAction(makeState({ errorType: 'unavailable' }));
    expect(decision.action).toBe('fallback');
    expect(decision.reason).toMatch(/provider unavailable/i);
  });

  it('auth → terminate', () => {
    const decision = decideNextAction(makeState({ errorType: 'auth' }));
    expect(decision.action).toBe('terminate');
    expect(decision.reason).toMatch(/authentication error/i);
  });

  it('network + consecutiveErrors = 1 → continue (will retry)', () => {
    const decision = decideNextAction(
      makeState({ errorType: 'network', consecutiveErrors: 1 }),
    );
    expect(decision.action).toBe('continue');
    expect(decision.reason).toMatch(/will retry/i);
  });

  it('network + consecutiveErrors = 2 → fallback', () => {
    const decision = decideNextAction(
      makeState({ errorType: 'network', consecutiveErrors: 2 }),
    );
    expect(decision.action).toBe('fallback');
  });

  it('network + consecutiveErrors = 0 → continue', () => {
    const decision = decideNextAction(
      makeState({ errorType: 'network', consecutiveErrors: 0 }),
    );
    expect(decision.action).toBe('continue');
  });
});

// --------------------------------------------------------------------------
// 3. Model output handling
// --------------------------------------------------------------------------

describe('decideNextAction – model output (max_tokens)', () => {
  it('stopReason = max_tokens → continuation', () => {
    const decision = decideNextAction(makeState({ stopReason: 'max_tokens' }));
    expect(decision.action).toBe('continuation');
  });

  it('continuation includes continuationPrompt param', () => {
    const decision = decideNextAction(makeState({ stopReason: 'max_tokens' }));
    expect(decision.params?.['continuationPrompt']).toBe(
      'Continue from where you stopped. Do not restate or apologize.',
    );
  });
});

// --------------------------------------------------------------------------
// 4. Preemptive context pressure
// --------------------------------------------------------------------------

describe('decideNextAction – context pressure', () => {
  it('input / maxTokens = 0.85 → compact', () => {
    const decision = decideNextAction(
      makeState({ tokenUsage: { input: 85_000, output: 1000 }, maxTokens: 100_000 }),
    );
    expect(decision.action).toBe('compact');
    expect(decision.reason).toMatch(/context pressure at 85%/);
  });

  it('input / maxTokens > 0.85 → compact', () => {
    const decision = decideNextAction(
      makeState({ tokenUsage: { input: 95_000, output: 1000 }, maxTokens: 100_000 }),
    );
    expect(decision.action).toBe('compact');
  });

  it('input / maxTokens < 0.85 → not compact from pressure', () => {
    const decision = decideNextAction(
      makeState({ tokenUsage: { input: 84_000, output: 1000 }, maxTokens: 100_000 }),
    );
    // Falls through to default
    expect(decision.action).toBe('continue');
  });
});

// --------------------------------------------------------------------------
// 5. Default continue
// --------------------------------------------------------------------------

describe('decideNextAction – default', () => {
  it('normal completion → continue', () => {
    const decision: LoopDecision = decideNextAction(makeState());
    expect(decision.action).toBe('continue');
    expect(decision.reason).toBe('normal');
  });

  it('end_turn with healthy state → continue', () => {
    const decision = decideNextAction(
      makeState({
        stopReason: 'end_turn',
        tokenUsage: { input: 10_000, output: 500 },
        maxTokens: 128_000,
        budgetRemaining: 0.8,
        iterationCount: 3,
      }),
    );
    expect(decision.action).toBe('continue');
  });
});
