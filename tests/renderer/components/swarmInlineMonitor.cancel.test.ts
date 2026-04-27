import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: vi.fn(),
}));

import { cancelSwarmRunOrFallback } from '../../../src/renderer/components/features/swarm/SwarmInlineMonitor';

describe('SwarmInlineMonitor stop all', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('uses run-level swarm cancellation before per-agent fallback', async () => {
    invokeMock.mockResolvedValueOnce(true);

    await cancelSwarmRunOrFallback([{ id: 'a1' }, { id: 'a2' }]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.SWARM_CANCEL_RUN);
  });

  it('falls back to cancelling active agents when run-level cancellation fails', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('run cancel unavailable'))
      .mockResolvedValue(undefined);

    await cancelSwarmRunOrFallback([{ id: 'a1' }, { id: 'a2' }]);

    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC_CHANNELS.SWARM_CANCEL_RUN);
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC_CHANNELS.SWARM_CANCEL_AGENT, { agentId: 'a1' });
    expect(invokeMock).toHaveBeenNthCalledWith(3, IPC_CHANNELS.SWARM_CANCEL_AGENT, { agentId: 'a2' });
  });
});
