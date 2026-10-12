// N-COMPANION-APPROVAL-DESKTOP-RESOLVED r2：审批应答的「未送达」信号必须穿过 HTTP
// transport。宿主（webPermissionResponseHandler）把迟到点击（手机已先答等）回报为
// HTTP 200 + {success:false, error:{code:'PENDING_PERMISSION_NOT_FOUND'}}；transport
// 曾把 success:false 一律坍缩成 undefined，renderer 的 isUndeliveredResponse(undefined)
// 恒 false——真链路上迟到点击会被记成本机决定。这里用**真 handler 产出线上 JSON +
// 真 httpTransport + 只 mock fetch** 钉住这个 seam。
import { afterEach, describe, expect, it, vi } from 'vitest';

// deliverForegroundPermissionResponse 的返回值按用例切换：undefined = 前台没有这条
// pending（落入 TaskManager 分支），'delivered' = 前台岛直接送达。
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

(globalThis as Record<string, unknown>).window = {
  __CODE_AGENT_TOKEN__: 'test-token',
};

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

function buildWebHandler() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  installPermissionResponseHandler({
    handlers,
    pendingDevPermissions: new Map(),
    getCurrentSessionId: () => 'session-late-click',
    logger: { info: () => {}, warn: () => {} },
  });
  const handler = handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE);
  if (!handler) throw new Error('permission response handler not installed');
  return handler;
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => '',
  };
}

describe('httpTransport keeps the permission response delivery signal intact', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    foregroundOutcome.value = undefined;
  });

  it('an undelivered late click keeps the {success:false, error} envelope across the transport', async () => {
    const handler = buildWebHandler();
    // 真 handler 对 unknown request 的产出。注意这是 HTTP 200 + 业务失败信封，
    // 不是 HTTP 错误码——所以 transport 的 !response.ok 分支帮不上忙。
    const wireJson = await handler(null, 'req-late', 'allow', 'session-late-click');
    expect(wireJson).toMatchObject({ success: false, error: { code: 'PENDING_PERMISSION_NOT_FOUND' } });

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(wireJson));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-late', 'allow', 'session-late-click');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8180/api/agent/permission-response');
    expect(init?.method).toBe('POST');
    // 位置参数按 Electron IPC 约定走数组 body，domain 兜底路由按数组展开回 handler。
    expect(JSON.parse(String(init?.body))).toEqual(['req-late', 'allow', 'session-late-click']);
    // 未送达信封必须活着到达 renderer（坍缩成 undefined 就是本单要堵的洞）。
    expect(result).toEqual(wireJson);
    expect(result).toMatchObject({ success: false, error: { code: 'PENDING_PERMISSION_NOT_FOUND' } });
  });

  it('a delivered response still unwraps to its data payload (desktop-first behaviour unchanged)', async () => {
    foregroundOutcome.value = 'delivered';
    const handler = buildWebHandler();
    const wireJson = await handler(null, 'req-ok', 'allow', 'session-late-click');
    expect(wireJson).toMatchObject({ success: true, data: { source: 'foreground-permission-island' } });

    globalThis.fetch = vi.fn(async () => jsonResponse(wireJson)) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-ok', 'allow', 'session-late-click');

    expect(result).toEqual({
      requestId: 'req-ok',
      sessionId: 'session-late-click',
      source: 'foreground-permission-island',
    });
  });
});
