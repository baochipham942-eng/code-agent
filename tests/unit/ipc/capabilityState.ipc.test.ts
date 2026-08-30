import { describe, expect, it, vi } from 'vitest';
import { registerCapabilityStateHandlers } from '../../../src/host/ipc/capabilityState.ipc';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

describe('capability-state:list IPC', () => {
  it('is public and returns only id, installed, version, and revision', async () => {
    const handle = vi.fn();
    const listStates = vi.fn(async () => [
      { id: 'builtin.voice-live' as const, installed: true, version: '1.0.0', revision: 7 },
      { id: 'builtin.voice-input' as const, installed: false, version: '1.0.0', revision: 9 },
    ]);
    registerCapabilityStateHandlers({ handle } as never, { listStates });

    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toBe(IPC_CHANNELS.CAPABILITY_STATE_LIST);
    const handler = handle.mock.calls[0]?.[1] as () => Promise<unknown>;
    await expect(handler()).resolves.toEqual([
      { id: 'builtin.voice-live', installed: true, version: '1.0.0', revision: 7 },
      { id: 'builtin.voice-input', installed: false, version: '1.0.0', revision: 9 },
    ]);
  });
});
