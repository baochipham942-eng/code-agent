// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessageMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/agent/useAgentEffects', () => ({
  useAgentEffects: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/agent/useAgentIPC', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/renderer/hooks/agent/useAgentIPC')
  >();
  return {
    ...actual,
    useAgentIPC: () => ({ sendMessage: sendMessageMock, cancel: cancelMock }),
  };
});

import { useAgent } from '../../../src/renderer/hooks/useAgent';
import { useRunControlStore } from '../../../src/renderer/stores/runControlStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

describe('useAgent to runControlStore projection', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    cancelMock.mockReset();
    useRunControlStore.setState({ actions: null });
    useSessionStore.setState({ currentSessionId: 'session-a', messages: [] });
  });

  it('publishes the foreground interrupt action', async () => {
    const hook = renderHook(() => useAgent());

    await waitFor(() => {
      expect(useRunControlStore.getState().actions?.interrupt).toBe(hook.result.current.cancel);
    });
  });

  it('drops the action when the chat runtime unmounts', async () => {
    const hook = renderHook(() => useAgent());
    await waitFor(() => expect(useRunControlStore.getState().actions).not.toBeNull());

    hook.unmount();

    expect(useRunControlStore.getState().actions).toBeNull();
  });
});
