// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  sessionId: null as string | null,
}));
const invoke = vi.hoisted(() => vi.fn());
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

const request: PermissionRequest = {
  id: 'permission-1',
  sessionId: 'request-session',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/report.txt' },
  timestamp: 1,
};

describe('PermissionCard respond path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.request = request;
    state.sessionId = 'session-current';
  });

  afterEach(cleanup);

  it('restores the snapshotted request and allows retry after delivery fails', async () => {
    invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    render(<PermissionCard />);

    fireEvent.click(screen.getByRole('button', { name: /允许/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        'allow',
        request.sessionId,
      );
      expect(setPendingPermissionRequest).toHaveBeenCalledWith(request, 'session-current');
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('请重试'));
    });

    fireEvent.click(screen.getByRole('button', { name: /允许/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setPendingPermissionRequest).toHaveBeenLastCalledWith(null));
  });
});
