import { beforeEach, describe, expect, it } from 'vitest';
import { useStatusStore } from '../../../src/renderer/stores/statusStore';

describe('statusStore turn cost accounting', () => {
  beforeEach(() => {
    useStatusStore.getState().resetSession();
  });

  it('known-price model accumulates sessionCost and records source', () => {
    const store = useStatusStore.getState();
    store.setCurrentTurnModel({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    store.recordTurnUsage({ inputTokens: 1_000_000, outputTokens: 0 });

    const s = useStatusStore.getState();
    expect(s.lastTurnCost?.usd).toBeGreaterThan(0);
    expect(s.lastTurnCost?.source).toBe('catalog');
    expect(s.sessionCost).toBeCloseTo(s.lastTurnCost?.usd as number, 8);
    expect(s.unknownCostTurns).toBe(0);
  });

  it('unknown-price model records null usd and bumps unknownCostTurns, never fabricates cost', () => {
    const store = useStatusStore.getState();
    store.setCurrentTurnModel({ provider: 'custom', model: 'custom-model' });
    store.recordTurnUsage({ inputTokens: 500_000, outputTokens: 500_000 });

    const s = useStatusStore.getState();
    expect(s.lastTurnCost?.usd).toBeNull();
    expect(s.lastTurnCost?.source).toBe('unknown');
    expect(s.sessionCost).toBe(0);
    expect(s.unknownCostTurns).toBe(1);
  });

  it('usage without a model decision counts as unknown', () => {
    useStatusStore.getState().recordTurnUsage({ inputTokens: 100, outputTokens: 100 });
    expect(useStatusStore.getState().unknownCostTurns).toBe(1);
  });

  it('resetSession clears cost tracking', () => {
    const store = useStatusStore.getState();
    store.setCurrentTurnModel({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    store.recordTurnUsage({ inputTokens: 1000, outputTokens: 1000 });
    store.resetSession();

    const s = useStatusStore.getState();
    expect(s.sessionCost).toBe(0);
    expect(s.lastTurnCost).toBeNull();
    expect(s.unknownCostTurns).toBe(0);
  });
});
