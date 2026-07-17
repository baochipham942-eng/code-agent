import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { MCPOAuthConsentResponse } from '../../../src/shared/contract';

const platformMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  send: vi.fn(),
  getAllWindows: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: { handle: platformMocks.handle },
  AppWindow: { getAllWindows: platformMocks.getAllWindows },
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

    await expect(result).resolves.toBe(true);
  });

  it('resolves false for an explicit decline response', async () => {
    const { requestMcpOAuthConsent, getResponseHandler } = await loadSubject();

    const result = requestMcpOAuthConsent(consentPayload(), { timeoutMs: 1000 });
    const request = platformMocks.send.mock.calls[0][1];
    await getResponseHandler()!({}, {
      requestId: request.requestId,
      action: 'decline',
    });

    await expect(result).resolves.toBe(false);
  });

  it('treats timeout as decline', async () => {
    vi.useFakeTimers();
    const { requestMcpOAuthConsent } = await loadSubject();

    const result = requestMcpOAuthConsent(consentPayload(), { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(false);
  });
});
