import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const consentMocks = vi.hoisted(() => ({
  requestMcpOAuthConsent: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('../../../src/host/mcp/mcpOAuthConsent', () => ({
  requestMcpOAuthConsent: consentMocks.requestMcpOAuthConsent,
}));

vi.mock('../../../src/host/platform/nativeShell', () => ({
  openExternal: consentMocks.openExternal,
}));

import {
  McpOAuthAuthorizationDeclinedError,
  McpOAuthCoordinator,
} from '../../../src/host/mcp/mcpOAuthCoordinator';

let coordinators: McpOAuthCoordinator[] = [];

beforeEach(() => {
  consentMocks.requestMcpOAuthConsent.mockReset();
  consentMocks.openExternal.mockReset();
});

afterEach(() => {
  for (const coordinator of coordinators) {
    coordinator.cancelAll();
  }
  coordinators = [];
});

function createCoordinator(): McpOAuthCoordinator {
  const coordinator = new McpOAuthCoordinator({ timeoutMs: 1000 });
  coordinators.push(coordinator);
  return coordinator;
}

describe('McpOAuthCoordinator consent opener', () => {
  it('builds the consent payload and opens the system browser when authorized', async () => {
    const coordinator = createCoordinator();
    consentMocks.requestMcpOAuthConsent.mockResolvedValue(true);
    const flow = await coordinator.beginFlow({
      serverName: 'Notion MCP',
      serverIdentity: 'notion:identity',
      serverUrl: 'https://mcp.example.com/mcp',
      configSource: 'project',
    });
    const authUrl = new URL('https://auth.example.com/oauth/authorize?scope=read%20write&state=state-1');

    await coordinator.handleAuthorizationRedirect({
      serverIdentity: 'notion:identity',
      flowId: flow.flowId,
      authUrl,
    });

    expect(consentMocks.requestMcpOAuthConsent).toHaveBeenCalledWith({
      serverName: 'Notion MCP',
      serverUrl: 'https://mcp.example.com/mcp',
      configSource: 'project',
      scope: 'read write',
      authorizationServer: 'https://auth.example.com',
      redirectHost: new URL(flow.redirectUrl).host,
    });
    expect(consentMocks.openExternal).toHaveBeenCalledWith(authUrl.toString());
  });

  it('cancels the flow and does not open the browser when declined', async () => {
    const coordinator = createCoordinator();
    consentMocks.requestMcpOAuthConsent.mockResolvedValue(false);
    const flow = await coordinator.beginFlow({
      serverName: 'Notion MCP',
      serverIdentity: 'notion:identity',
      serverUrl: 'https://mcp.example.com/mcp',
      configSource: 'user',
    });
    const callback = coordinator.waitForCallback(flow.flowId);

    await expect(coordinator.handleAuthorizationRedirect({
      serverIdentity: 'notion:identity',
      flowId: flow.flowId,
      authUrl: new URL('https://auth.example.com/oauth/authorize'),
    })).rejects.toBeInstanceOf(McpOAuthAuthorizationDeclinedError);

    expect(consentMocks.openExternal).not.toHaveBeenCalled();
    await expect(callback).rejects.toThrow('MCP OAuth flow cancelled');
  });
});
