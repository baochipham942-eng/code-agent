import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke,
    on: vi.fn(() => () => undefined),
  },
}));

import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

describe('bundled capability renderer store', () => {
  beforeEach(() => {
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
      states: [],
      loaded: false,
      error: null,
    });
    invoke.mockReset();
  });

  it('projects capability-state:list as the single renderer availability source', async () => {
    invoke.mockResolvedValue([
      { id: 'builtin.voice-live', installed: true, version: '1.0.0', revision: 2 },
      { id: 'builtin.voice-input', installed: true, version: '1.0.0', revision: 4 },
    ]);

    await useBundledCapabilityStore.getState().refresh();

    expect(useBundledCapabilityStore.getState()).toMatchObject({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': true },
      loaded: true,
      error: null,
    });
  });

  it('fails closed and clears stale installed state when list loading fails', async () => {
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': true },
      loaded: true,
    });
    invoke.mockRejectedValue(new Error('IPC unavailable'));

    await useBundledCapabilityStore.getState().refresh();

    expect(useBundledCapabilityStore.getState()).toMatchObject({
      installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
      loaded: false,
      error: 'IPC unavailable',
    });
  });
});
