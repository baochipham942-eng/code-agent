import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { MCPOAuthConsentResponse } from '../../../src/shared/contract';
import {
  hasInteractiveUi as realHasInteractiveUi,
  setBrowserWindowInteractionProbe,
} from '../../../src/host/platform/windowBridge';

const platformMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
  getAllWindows: vi.fn(),
  hasInteractiveUi: vi.fn(),
}));
const notifyNeedsInputMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: platformMocks.handle },
  hasInteractiveUi: platformMocks.hasInteractiveUi,
  AppWindow: { getAllWindows: platformMocks.getAllWindows },
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: notifyNeedsInputMock },
}));

async function loadSubject() {
  vi.resetModules();
  let responseHandler: ((event: unknown, response: MCPOAuthConsentResponse) => Promise<void>) | undefined;
  platformMocks.handle.mockImplementation((channel, handler) => {
    if (channel === IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE) {
      responseHandler = handler;
    }
  });
  const subject = await import('../../../src/host/mcp/mcpOAuthConsent');
  return { ...subject, getResponseHandler: () => responseHandler };
}

function consentPayload() {
  return {
    serverName: 'Notion MCP',
    serverUrl: 'https://mcp.example.com/mcp',
    configSource: 'project',
    scope: 'read write',
    authorizationServer: 'https://auth.example.com',
    redirectHost: '127.0.0.1:49152',
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  platformMocks.getAllWindows.mockReturnValue([{ webContents: { send: platformMocks.send } }]);
  platformMocks.hasInteractiveUi.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(null);
});

describe('MCP OAuth consent bridge', () => {
  it('sends the six-field payload and resolves an authorize response', async () => {
    const { requestMcpOAuthConsent, getResponseHandler } = await loadSubject();

    const result = requestMcpOAuthConsent(consentPayload(), { timeoutMs: 1000 });

    expect(platformMocks.handle).toHaveBeenCalledWith(
      IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE,
      expect.any(Function),
    );
    expect(platformMocks.send).toHaveBeenCalledWith(
      IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST,
      expect.objectContaining(consentPayload()),
    );
    const request = platformMocks.send.mock.calls[0][1];
    expect(Object.keys(request).sort()).toEqual([
      'authorizationServer',
      'configSource',
      'redirectHost',
      'requestId',
      'scope',
      'serverName',
      'serverUrl',
    ]);
    expect(request.requestId).toMatch(/^mcp-oauth-consent-/);

    await getResponseHandler()!({}, {
      requestId: request.requestId,
      action: 'authorize',
    });

    await expect(result).resolves.toMatchObject({
      granted: true,
      timedOut: false,
      permissionDecision: 'allow',
    });
  });

  it('resolves false for an explicit decline response', async () => {
    const { requestMcpOAuthConsent, getResponseHandler } = await loadSubject();

    const result = requestMcpOAuthConsent(consentPayload(), { timeoutMs: 1000 });
    const request = platformMocks.send.mock.calls[0][1];
    await getResponseHandler()!({}, {
      requestId: request.requestId,
      action: 'decline',
    });

    await expect(result).resolves.toMatchObject({
      granted: false,
      timedOut: false,
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('用户拒绝'),
    });
  });

  it('treats timeout as decline', async () => {
    vi.useFakeTimers();
    const { requestMcpOAuthConsent } = await loadSubject();

    const result = requestMcpOAuthConsent(consentPayload(), { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toMatchObject({
      granted: false,
      timedOut: true,
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('无头规则'),
    });
  });

  it('有交互 UI 时忽略原 OAuth 短超时，挂起后仍可授权', async () => {
    vi.useFakeTimers();
    setBrowserWindowInteractionProbe(() => true);
    platformMocks.hasInteractiveUi.mockImplementation(realHasInteractiveUi);
    const { requestMcpOAuthConsent, getResponseHandler } = await loadSubject();

    const result = requestMcpOAuthConsent(consentPayload(), { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(notifyNeedsInputMock).toHaveBeenCalledTimes(1);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);
    const request = platformMocks.send.mock.calls[0][1];
    await getResponseHandler()!({}, { requestId: request.requestId, action: 'authorize' });

    await expect(result).resolves.toMatchObject({ granted: true, permissionDecision: 'allow' });
  });

  it('limits interactive connector consent to a minutes-scale timeout', async () => {
    vi.useFakeTimers();
    platformMocks.hasInteractiveUi.mockReturnValue(true);
    const { requestMcpOAuthConsent } = await loadSubject();

    const result = requestMcpOAuthConsent({ ...consentPayload(), kind: 'connector' }, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toMatchObject({
      granted: false,
      timedOut: true,
      permissionDecisionReason: expect.stringContaining('已停止连接'),
    });
  });

  it('registers a cancellable pending request before the first renderer dispatch', async () => {
    const { requestMcpOAuthConsent, cancelPendingMcpOAuthConsent } = await loadSubject();
    platformMocks.send.mockImplementationOnce((_channel, request) => {
      expect(request.serverName).toBe('Notion MCP');
      expect(cancelPendingMcpOAuthConsent('Notion MCP')).toBe(true);
    });

    await expect(requestMcpOAuthConsent(consentPayload(), { timeoutMs: 1000 }))
      .resolves.toMatchObject({ granted: false, timedOut: false });
  });
});
