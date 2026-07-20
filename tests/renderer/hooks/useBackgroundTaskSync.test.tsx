// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_POLLING } from '../../../src/shared/constants';

const backgroundTaskStore = vi.hoisted(() => ({
  refreshTasks: vi.fn(async () => {}),
  drainNotifications: vi.fn(async () => []),
}));
const sessionStore = vi.hoisted(() => ({ currentSessionId: 'session-current' as string | null }));
const ipc = vi.hoisted(() => ({
  handler: null as null | ((event: { type: string; data: unknown }) => void),
  unsubscribe: vi.fn(),
}));
const transport = vi.hoisted(() => ({ native: true }));
const poller = vi.hoisted(() => ({
  create: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: typeof backgroundTaskStore) => unknown) => (
    selector(backgroundTaskStore)
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionStore) => unknown) => selector(sessionStore),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: (_channel: string, handler: typeof ipc.handler) => {
      ipc.handler = handler;
      return ipc.unsubscribe;
    },
  },
}));
vi.mock('../../../src/renderer/api/transport', () => ({
  hasNativeBridge: () => transport.native,
}));
vi.mock('../../../src/renderer/utils/backoffPoller', () => ({
  createBackoffPoller: poller.create,
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useBackgroundTaskSync } from '../../../src/renderer/hooks/useBackgroundTaskSync';

describe('useBackgroundTaskSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ipc.handler = null;
    transport.native = true;
    sessionStore.currentSessionId = 'session-current';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces ledger invalidations and runs the existing sync path', async () => {
    renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(backgroundTaskStore.refreshTasks).toHaveBeenCalledTimes(1);
    backgroundTaskStore.refreshTasks.mockClear();
    backgroundTaskStore.drainNotifications.mockClear();

    act(() => {
      ipc.handler?.({ type: 'background_task_ledger_changed', data: { taskId: 'task-1' } });
      ipc.handler?.({ type: 'background_task_ledger_changed', data: { taskId: 'task-1' } });
    });

    expect(backgroundTaskStore.refreshTasks).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    expect(backgroundTaskStore.refreshTasks).toHaveBeenCalledTimes(1);
    expect(backgroundTaskStore.drainNotifications).toHaveBeenCalledTimes(1);
    expect(backgroundTaskStore.drainNotifications).toHaveBeenCalledWith('session-current');
  });

  it('ignores unrelated events and cleans up the subscription', async () => {
    const { unmount } = renderHook(() => useBackgroundTaskSync({ pollInterval: 0 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(backgroundTaskStore.refreshTasks).toHaveBeenCalledTimes(1);
    backgroundTaskStore.refreshTasks.mockClear();

    act(() => {
      ipc.handler?.({ type: 'task_progress', data: {} });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    expect(backgroundTaskStore.refreshTasks).not.toHaveBeenCalled();
    unmount();
    expect(ipc.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('uses a 30 second fallback only when the native push bridge is available', () => {
    const nativeView = renderHook(() => useBackgroundTaskSync());
    expect(poller.create).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ baseInterval: RENDERER_POLLING.BACKGROUND_TASK_FALLBACK }),
    );
    nativeView.unmount();

    transport.native = false;
    const httpView = renderHook(() => useBackgroundTaskSync());
    expect(poller.create).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ baseInterval: RENDERER_POLLING.BACKGROUND_TASK_BASE }),
    );
    httpView.unmount();
  });
});
