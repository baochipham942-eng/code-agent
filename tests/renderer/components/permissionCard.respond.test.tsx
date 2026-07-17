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
const saveMemory = vi.hoisted(() => vi.fn());
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const ipcAvailable = vi.hoisted(() => ({ value: true }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest,
    language: 'zh',
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
    selector({ currentSessionId: 'session-current' }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => ipcAvailable.value, invoke },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { ApprovalSyncCard } from '../../../src/renderer/components/TaskPanel/ApprovalSyncCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

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
    ipcAvailable.value = true;
    state.request = request;
    state.sessionId = 'session-current';
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
    vi.restoreAllMocks();
  });

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

  it('keeps the pending request and allows retry when IPC is unavailable', async () => {
    ipcAvailable.value = false;
    render(<PermissionCard />);

    fireEvent.click(screen.getByRole('button', { name: /允许/ }));

    await waitFor(() => {
      expect(invoke).not.toHaveBeenCalled();
      expect(setPendingPermissionRequest).toHaveBeenCalledWith(request, 'session-current');
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('请重试'));
    });

    ipcAvailable.value = true;
    fireEvent.click(screen.getByRole('button', { name: /允许/ }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(setPendingPermissionRequest).toHaveBeenLastCalledWith(null));
  });

  it('releases the response claim and allows retry when saving memory throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    saveMemory.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    render(<PermissionCard />);

    fireEvent.keyDown(window, { key: 's' });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[PermissionCard] Failed to save approval memory',
        expect.any(Error),
      );
      expect(setPendingPermissionRequest).toHaveBeenCalledWith(request, 'session-current');
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('请重试'));
    });

    fireEvent.keyDown(window, { key: 's' });

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setPendingPermissionRequest).toHaveBeenLastCalledWith(null));
  });

  it('prevents the second surface from responding while the first is in flight', async () => {
    let resolveInvoke!: () => void;
    invoke.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveInvoke = resolve;
    }));
    render(
      <>
        <ApprovalSyncCard />
        <PermissionCard />
      </>,
    );

    const allowButtons = screen.getAllByRole('button', { name: /允许/ });
    fireEvent.click(allowButtons[0]);
    fireEvent.click(allowButtons[1]);

    expect(invoke).toHaveBeenCalledTimes(1);
    resolveInvoke();
    await waitFor(() => expect(setPendingPermissionRequest).toHaveBeenCalledWith(null));
  });
});
