import { describe, expect, it, vi } from 'vitest';
import { registerCapabilityStateHandlers } from '../../../src/host/ipc/capabilityState.ipc';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

describe('capability-state IPC', () => {
  it('registers list/install/uninstall/readiness and keeps the list projection public', async () => {
    const handle = vi.fn();
    const listStates = vi.fn(async () => [
      { id: 'builtin.voice-live' as const, installed: true, version: '1.0.0', revision: 7 },
      { id: 'builtin.voice-input' as const, installed: false, version: '1.0.0', revision: 9 },
    ]);
    const install = vi.fn(async () => undefined);
    const uninstall = vi.fn(async () => undefined);
    const getReadiness = vi.fn(async () => ({
      id: 'builtin.voice-input' as const,
      status: 'fallback' as const,
      detail: 'Groq fallback',
      preservesExternalAssetsOnUninstall: true,
    }));
    registerCapabilityStateHandlers({ handle } as never, {
      getReadiness,
      install,
      listStates,
      uninstall,
    });

    expect(handle).toHaveBeenCalledTimes(4);
    const handlers = new Map(handle.mock.calls.map(([channel, handler]) => [channel, handler]));
    const listHandler = handlers.get(IPC_CHANNELS.CAPABILITY_STATE_LIST) as () => Promise<unknown>;
    await expect(listHandler()).resolves.toEqual([
      { id: 'builtin.voice-live', installed: true, version: '1.0.0', revision: 7 },
      { id: 'builtin.voice-input', installed: false, version: '1.0.0', revision: 9 },
    ]);
    const event = {};
    type CapabilityHandler = (
      event: unknown,
      id: 'builtin.voice-input',
    ) => Promise<unknown>;
    await (handlers.get(IPC_CHANNELS.CAPABILITY_STATE_INSTALL) as CapabilityHandler)(event, 'builtin.voice-input');
    await (handlers.get(IPC_CHANNELS.CAPABILITY_STATE_UNINSTALL) as CapabilityHandler)(event, 'builtin.voice-input');
    await (handlers.get(IPC_CHANNELS.CAPABILITY_STATE_READINESS) as CapabilityHandler)(event, 'builtin.voice-input');
    expect(install).toHaveBeenCalledWith('builtin.voice-input', { source: 'user' });
    expect(uninstall).toHaveBeenCalledWith('builtin.voice-input');
    expect(getReadiness).toHaveBeenCalledWith('builtin.voice-input');
  });
});
