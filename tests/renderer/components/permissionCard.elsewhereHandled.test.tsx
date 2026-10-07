// @vitest-environment jsdom
// N-COMPANION-APPROVAL-DESKTOP-RESOLVED：手机先答后，桌面上迟到的点击拿到
// 未送达结果（unknown_request / PENDING_PERMISSION_NOT_FOUND / success:false）——
// 不记成本机决定（recordPermissionDecision 不得被调）、不留卡，并明说「已在其他设备处理」。
// 独立成文件而不是塞进 permissionCard.respond.test.tsx：那个文件的 appStore mock
// 不带 recordPermissionDecision（走 else 分支），补上会改变既有用例的断言路径。
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
const recordPermissionDecision = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: state.sessionId,
    setPendingPermissionRequest,
    recordPermissionDecision,
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
  default: { isAvailable: () => true, invoke },
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';
import { zh } from '../../../src/renderer/i18n/zh';

const request: PermissionRequest = {
  id: 'permission-elsewhere',
  sessionId: 'request-session',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/report.txt' },
  timestamp: 1,
};

function confirmAllowOnce() {
  fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
}

describe('PermissionCard click that was already answered elsewhere', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.request = request;
    state.sessionId = 'session-current';
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
    vi.restoreAllMocks();
  });

  it('web-shaped not-delivered result: no local decision record, card dropped, other-device toast', async () => {
    invoke.mockResolvedValueOnce({
      success: false,
      error: { code: 'PENDING_PERMISSION_NOT_FOUND', message: 'already resolved elsewhere' },
    });
    render(<PermissionCard />);

    confirmAllowOnce();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        'allow',
        request.sessionId,
      );
      expect(recordPermissionDecision).not.toHaveBeenCalled();
      expect(setPendingPermissionRequest).toHaveBeenCalledWith(null);
      expect(toastError).toHaveBeenCalledWith(zh.decisionCard.permission.settledElsewhere);
    });
  });

  it('electron-shaped unknown_request outcome is treated the same', async () => {
    invoke.mockResolvedValueOnce({ outcome: 'unknown_request' });
    render(<PermissionCard />);

    confirmAllowOnce();

    await waitFor(() => {
      expect(recordPermissionDecision).not.toHaveBeenCalled();
      expect(setPendingPermissionRequest).toHaveBeenCalledWith(null);
      expect(toastError).toHaveBeenCalledWith('已在其他设备处理');
    });
  });

  it('delivered results keep today behaviour: decision recorded, no toast', async () => {
    invoke.mockResolvedValueOnce({ success: true, data: { requestId: request.id, source: 'task-manager' } });
    render(<PermissionCard />);

    confirmAllowOnce();

    await waitFor(() => {
      expect(recordPermissionDecision).toHaveBeenCalledWith(
        expect.objectContaining({ id: request.id }),
        'once',
        'session-current',
      );
      expect(setPendingPermissionRequest).not.toHaveBeenCalledWith(null);
      expect(toastError).not.toHaveBeenCalled();
    });
  });
});
