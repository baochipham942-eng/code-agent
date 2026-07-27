import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

import {
  initializeStatusStore,
  useStatusStore,
} from '../../../src/renderer/stores/statusStore';

describe('statusStore today cost hydration', () => {
  beforeEach(() => {
    invokeDomain.mockReset();
    useStatusStore.setState({
      sessionCost: 0,
      unknownCostTurns: 0,
      lastTurnCost: null,
      currentTurnModel: null,
    });
  });

  it('hydrates persisted totals once and keeps later stream increments', async () => {
    invokeDomain.mockResolvedValue({ usd: 1.5, unknownTurns: 2 });

    await initializeStatusStore();

    expect(invokeDomain).toHaveBeenCalledWith(
      IPC_DOMAINS.STATUS,
      'getTodayCost',
    );
    expect(useStatusStore.getState()).toMatchObject({
      sessionCost: 1.5,
      unknownCostTurns: 2,
    });

    const store = useStatusStore.getState();
    store.setCurrentTurnModel({ provider: 'deepseek', model: 'deepseek-v4-pro' });
    store.recordTurnUsage({ inputTokens: 1_000_000, outputTokens: 0 });

    const hydrated = useStatusStore.getState();
    expect(hydrated.sessionCost).toBeCloseTo(
      1.5 + (hydrated.lastTurnCost?.usd ?? 0),
      8,
    );
    expect(hydrated.unknownCostTurns).toBe(2);
  });
});
