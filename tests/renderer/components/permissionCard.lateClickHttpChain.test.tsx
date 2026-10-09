// @vitest-environment jsdom
// N-COMPANION-APPROVAL-DESKTOP-RESOLVED r2：迟到点击的「已在其他设备处理」要在**真
// HTTP 链**上成立，而不是 ipcService mock 直接返回 {success:false}（真 transport 从前
// 会把 success:false 坍缩成 undefined，mock 测不出这个洞）。这里整链只 mock 两端：
// fetch（返回真 webPermissionResponseHandler 对 unknown request 的产出 JSON）和
// renderer store/toast，中间的 ipcService + httpTransport 全是真的。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const foregroundOutcome = vi.hoisted(() => ({ value: undefined as string | undefined }));

// webPermissionResponseHandler 的三个协作方，mock 成「前台没有这条 pending」：
// unknown-request 场景由 handler 自身的 FAILURE_CODES 映射产出真实线上 JSON。
vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ handlePermissionResponse: () => 'unknown_request' }),
}));
vi.mock('../../../src/web/foregroundPermissionRegistry', () => ({
  deliverForegroundPermissionResponse: () => foregroundOutcome.value,
}));
vi.mock('../../../src/host/agent/parkedApprovalHydration', () => ({
  closeDeadParkedApproval: () => false,
}));
vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const saveMemory = vi.hoisted(() => vi.fn());
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());
const dismissPermissionRequest = vi.hoisted(() => vi.fn());
const recordPermissionDecision = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest,
    dismissPermissionRequest,
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

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { error: toastError },
}));

// 注意：ipcService 与 httpTransport 都不 mock——组件点击走真 invoke → 真 transport。

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';
import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const request: PermissionRequest = {
  id: 'permission-http-chain',
  sessionId: 'session-current',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/report.txt' },
  timestamp: 1,
};

/** 真 web handler 对一次应答产出的线上 JSON（fetch 会原样回它）。 */
async function webHandlerJson(requestId: string, response: 'allow' | 'deny') {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  installPermissionResponseHandler({
    handlers,
    pendingDevPermissions: new Map(),
    getCurrentSessionId: () => 'session-current',
    logger: { info: () => {}, warn: () => {} },
  });
  const handler = handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE);
  if (!handler) throw new Error('permission response handler not installed');
  return handler(null, requestId, response, 'session-current');
}

function confirmAllowOnce() {
  fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
}

describe('PermissionCard late click over the real HTTP chain', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // 真桥：组件里的 ipcService.invoke 会读 window.codeAgentAPI。
    window.codeAgentAPI = createHttpCodeAgentAPI('http://localhost:8180');
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    foregroundOutcome.value = undefined;
    delete window.codeAgentAPI;
  });

  it('undelivered (phone answered first): other-device toast, no local decision, card dismissed', async () => {
    const wireJson = await webHandlerJson(request.id, 'allow');
    expect(wireJson).toMatchObject({ success: false, error: { code: 'PENDING_PERMISSION_NOT_FOUND' } });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => wireJson,
      text: async () => '',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<PermissionCard requestOverride={request} sessionIdOverride="session-current" />);
    confirmAllowOnce();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8180/api/agent/permission-response',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(recordPermissionDecision).not.toHaveBeenCalled();
      expect(dismissPermissionRequest).toHaveBeenCalledWith(request.id);
      expect(toastError).toHaveBeenCalledWith(zh.decisionCard.permission.settledElsewhere);
    });
  });

  it('delivered response keeps today behaviour through the same chain', async () => {
    foregroundOutcome.value = 'delivered';
    const wireJson = await webHandlerJson(request.id, 'allow');
    expect(wireJson).toMatchObject({ success: true, data: { source: 'foreground-permission-island' } });

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => wireJson,
      text: async () => '',
    })) as unknown as typeof fetch;

    render(<PermissionCard requestOverride={request} sessionIdOverride="session-current" />);
    confirmAllowOnce();

    await waitFor(() => {
      expect(recordPermissionDecision).toHaveBeenCalledWith(
        expect.objectContaining({ id: request.id }),
        'once',
        'session-current',
      );
      expect(toastError).not.toHaveBeenCalled();
      expect(dismissPermissionRequest).not.toHaveBeenCalled();
    });
  });
});
