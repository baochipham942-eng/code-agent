// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const listeners = new Map<string, (payload: unknown) => void>();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  ipcService: {
    on: (channel: string, cb: (payload: unknown) => void) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    },
  },
}));

import { useInAppValidationBridge } from '../../../src/renderer/hooks/useInAppValidationBridge';
import { useAppStore } from '../../../src/renderer/stores/appStore';

describe('useInAppValidationBridge', () => {
  beforeEach(() => {
    listeners.clear();
    useAppStore.setState({
      showInAppValidation: false,
      pendingInAppValidationRequest: null,
    });
  });

  it('opens the main validation page for any account, not the eval center', () => {
    renderHook(() => useInAppValidationBridge());
    const handler = listeners.get(IPC_CHANNELS.IN_APP_VALIDATION_REQUEST);
    expect(handler).toBeTypeOf('function');

    act(() => {
      handler?.({ requestId: 'req-1', html: '<p>hi</p>', steps: [] });
    });

    expect(useAppStore.getState().showInAppValidation).toBe(true);
    expect(useAppStore.getState().pendingInAppValidationRequest).toMatchObject({ requestId: 'req-1' });
  });
});
