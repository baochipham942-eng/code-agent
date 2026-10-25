// @vitest-environment jsdom
// N-APPROVAL-LANE-CLICK-DROP：审批应答的**传输故障**（fetch 拒绝 / HTTP 500 / 401 token
// 失效 / 200 非 JSON）必须让卡片走 catch 留卡重试，而不是被 httpTransport 坍缩成
// undefined 后当「已送达」处理（FB-419：卡消失、宿主干等到 330s 超时否认）。
// 与 lateClick 用例同骨架：真 PermissionCard + 真 ipcService + 真 httpTransport，
// 只 mock fetch 和 renderer store/toast。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const foregroundOutcome = vi.hoisted(() => ({ value: undefined as string | undefined }));

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
const dismissPermissionRequest = vi.hoisted(() => vi.fn());
const recordPermissionDecision = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  request: null as PermissionRequest | null,
  sessionId: null as string | null,
}));

// setPendingPermissionRequest 做成有状态实现：catch 里的「留卡」恢复调用会真切回
// appState.request，卡是否还在 DOM 里可以被直接断言。
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: appState.request,
    pendingPermissionSessionId: appState.sessionId,
    setPendingPermissionRequest: (req: PermissionRequest | null, sessionId: string | null) => {
      appState.request = req;
      appState.sessionId = sessionId;
    },
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
import { claimApprovalResponse, releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';
import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const request: PermissionRequest = {
  id: 'permission-transport-failure',
  sessionId: 'session-current',
  tool: 'Bash',
  type: 'command',
  details: { command: 'npm test' },
  timestamp: 1,
};

/** 真 web handler 对一次成功送达产出的线上 JSON（第二次点击成功时 fetch 回它）。 */
async function deliveredWireJson() {
  foregroundOutcome.value = 'delivered';
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  installPermissionResponseHandler({
    handlers,
    pendingDevPermissions: new Map(),
    getCurrentSessionId: () => 'session-current',
    logger: { info: () => {}, warn: () => {} },
  });
  const handler = handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE);
  if (!handler) throw new Error('permission response handler not installed');
  return handler(null, request.id, 'allow', 'session-current');
}

function confirmAllowOnce() {
  fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
}

/**
 * 四种传输故障形状的统一断言：失败点击后卡片恢复可见、浮「请重试」toast、
 * 不记本地决定、claim 释放；随后 fetch 恢复，第二次点击真正送达。
 */
async function expectFailureKeepsCardThenRetryDelivers(
  failingFetch: typeof fetch,
): Promise<void> {
  const fetchMock = vi.fn(failingFetch);
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  render(<PermissionCard />);
  confirmAllowOnce();

  await waitFor(() => {
    expect(toastError).toHaveBeenCalledWith('审批响应发送失败，请重试');
  });
  expect(recordPermissionDecision).not.toHaveBeenCalled();
  expect(dismissPermissionRequest).not.toHaveBeenCalled();
  // 留卡：catch 把 request 恢复回 store，卡片仍在 DOM。
  expect(appState.request).toEqual(request);
  expect(screen.getByTestId('permission-card')).toBeTruthy();
  // claim 已释放（第二次点击能重新认领）。
  expect(claimApprovalResponse(request.id)).toBe(true);
  releaseApprovalResponse(request.id);

  const wireJson = await deliveredWireJson();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => wireJson,
    text: async () => '',
  }) as unknown as Response);

  confirmAllowOnce();

  await waitFor(() => {
    expect(recordPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ id: request.id }),
      'once',
      'session-current',
    );
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
}

describe('PermissionCard transport failure over the real HTTP chain', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    appState.request = request;
    appState.sessionId = 'session-current';
    foregroundOutcome.value = undefined;
    window.sessionStorage.clear();
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

  it('fetch rejects (network down): card restored with retry toast, second click delivers', async () => {
    await expectFailureKeepsCardThenRetryDelivers(
      (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    );
  });

  it('HTTP 500: card restored with retry toast, second click delivers', async () => {
    await expectFailureKeepsCardThenRetryDelivers(
      (async () => ({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: 'boom' }),
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
  });

  it('HTTP 401 auth token expired: card restored with retry toast, second click delivers', async () => {
    await expectFailureKeepsCardThenRetryDelivers(
      (async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'Invalid auth token' } }),
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
  });

  it('HTTP 200 non-JSON body: card restored with retry toast, second click delivers', async () => {
    await expectFailureKeepsCardThenRetryDelivers(
      (async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html>gateway error page</html>',
        json: async () => {
          throw new Error('not json');
        },
      })) as unknown as typeof fetch,
    );
  });
});
