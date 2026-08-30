// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain },
}));

import { useVoiceLiveAvailability } from '../../../src/renderer/components/features/voice/useVoiceLiveAvailability';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';

describe('useVoiceLiveAvailability default and degraded entry', () => {
  beforeEach(() => {
    invokeDomain.mockReset();
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': true, 'builtin.voice-input': false },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        provider: 'dashscope-qwen-omni',
        configured: false,
        active: false,
        usage: { monthSeconds: 0, monthCalls: 0, monthFailedAttempts: 0 },
      }),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the entry enabled when legacy settings omit enabled and the provider key is missing', async () => {
    invokeDomain.mockResolvedValue({ voice: { live: {} } });

    const { result } = renderHook(() => useVoiceLiveAvailability());

    await waitFor(() => {
      expect(result.current).toMatchObject({ enabled: true, configured: false });
    });
  });

  it('still hides the entry for an explicit enabled:false setting', async () => {
    invokeDomain.mockResolvedValue({ voice: { live: { enabled: false } } });

    const { result } = renderHook(() => useVoiceLiveAvailability());

    await waitFor(() => expect(result.current.enabled).toBe(false));
  });

  it('does not touch settings or status endpoints while voice-live is removed', async () => {
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    });

    const { result } = renderHook(() => useVoiceLiveAvailability());

    expect(result.current).toMatchObject({ enabled: false, configured: false });
    expect(invokeDomain).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
