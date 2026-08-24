import {
  OAuthCoordinator,
  OAUTH_FLOW_TIMEOUT_MS,
  type OAuthCallbackResult,
  type OAuthCoordinatorMessages,
  type OAuthFlow,
} from '../connectors/oauth/oauthCoordinator';

export const MCP_OAUTH_FLOW_TIMEOUT_MS = OAUTH_FLOW_TIMEOUT_MS;

export interface BeginMcpOAuthFlowInput {
  serverName: string;
  serverIdentity: string;
  authorizationServerIssuer: string;
  serverUrl?: string;
  configSource?: string;
}

export interface McpOAuthFlow {
  flowId: string;
  serverName: string;
  serverIdentity: string;
  authorizationServerIssuer: string;
  serverUrl?: string;
  configSource?: string;
  state: string;
  redirectUrl: string;
  authorizationUrl?: string;
}

export interface McpOAuthCallbackResult {
  flowId: string;
  serverName: string;
  serverIdentity: string;
  state: string;
  code: string;
}

export interface McpOAuthCoordinatorOptions {
  timeoutMs?: number;
  openAuthorization?: (authUrl: URL, flow: McpOAuthFlow) => void | Promise<void>;
}

export class McpOAuthAuthorizationDeclinedError extends Error {
  constructor(message = 'MCP OAuth authorization declined') {
    super(message);
    this.name = 'McpOAuthAuthorizationDeclinedError';
  }
}

const MCP_MESSAGES: OAuthCoordinatorMessages = {
  inactiveForAccount: (serverIdentity) => `MCP OAuth flow is not active for ${serverIdentity}`,
  inactiveFlow: (flowId) => `MCP OAuth flow is not active: ${flowId}`,
  cancelled: 'MCP OAuth flow cancelled',
  timedOut: 'MCP OAuth flow timed out',
  issuerMismatch: (expected, received) =>
    `MCP OAuth issuer mismatch: expected "${expected}", received "${received}"`,
  loopbackAddressUnavailable: 'MCP OAuth loopback server did not expose a TCP address',
};

export class McpOAuthCoordinator {
  private readonly coordinator: OAuthCoordinator;

  constructor(options: McpOAuthCoordinatorOptions = {}) {
    const openAuthorization = options.openAuthorization ?? openAuthorizationWithConsent;
    this.coordinator = new OAuthCoordinator({
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      messages: MCP_MESSAGES,
      openAuthorization: (authUrl, flow) => openAuthorization(authUrl, toMcpFlow(flow)),
    });
  }

  async beginFlow(input: BeginMcpOAuthFlowInput): Promise<McpOAuthFlow> {
    const flow = await this.coordinator.beginFlow({
      accountLabel: input.serverName,
      accountId: input.serverIdentity,
      authorizationServerIssuer: input.authorizationServerIssuer,
      redirect: { mode: 'loopback-random' },
      ...(input.serverUrl !== undefined ? { resourceUrl: input.serverUrl } : {}),
      ...(input.configSource !== undefined ? { configSource: input.configSource } : {}),
    });
    return toMcpFlow(flow);
  }

  getRedirectUrl(serverIdentity: string): string {
    return this.coordinator.getRedirectUrl(serverIdentity);
  }

  getFlowForServerIdentity(serverIdentity: string): McpOAuthFlow | undefined {
    const flow = this.coordinator.getFlowForAccountId(serverIdentity);
    return flow ? toMcpFlow(flow) : undefined;
  }

  handleAuthorizationRedirect(input: {
    serverIdentity: string;
    flowId?: string;
    authUrl: URL;
  }): Promise<void> {
    return this.coordinator.handleAuthorizationRedirect({
      accountId: input.serverIdentity,
      ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      authUrl: input.authUrl,
    });
  }

  async waitForCallback(flowId: string): Promise<McpOAuthCallbackResult> {
    return toMcpCallbackResult(await this.coordinator.waitForCallback(flowId));
  }

  cancelFlow(flowId: string): boolean {
    return this.coordinator.cancelFlow(flowId);
  }

  cancelFlowForServerIdentity(serverIdentity: string): boolean {
    return this.coordinator.cancelFlowForAccountId(serverIdentity);
  }

  cancelAll(): void {
    this.coordinator.cancelAll();
  }
}

function toMcpFlow(flow: OAuthFlow): McpOAuthFlow {
  return {
    flowId: flow.flowId,
    serverName: flow.accountLabel,
    serverIdentity: flow.accountId,
    authorizationServerIssuer: flow.authorizationServerIssuer,
    ...(flow.resourceUrl !== undefined ? { serverUrl: flow.resourceUrl } : {}),
    ...(flow.configSource !== undefined ? { configSource: flow.configSource } : {}),
    state: flow.state,
    redirectUrl: flow.redirectUrl,
    ...(flow.authorizationUrl !== undefined ? { authorizationUrl: flow.authorizationUrl } : {}),
  };
}

function toMcpCallbackResult(result: OAuthCallbackResult): McpOAuthCallbackResult {
  return {
    flowId: result.flowId,
    serverName: result.accountLabel,
    serverIdentity: result.accountId,
    state: result.state,
    code: result.code,
  };
}

async function openAuthorizationWithConsent(authUrl: URL, flow: McpOAuthFlow): Promise<void> {
  const [{ requestMcpOAuthConsent }, { openExternal }] = await Promise.all([
    import('./mcpOAuthConsent'),
    import('../platform/nativeShell'),
  ]);
  const redirectHost = new URL(flow.redirectUrl).host;
  const consentGranted = await requestMcpOAuthConsent({
    serverName: flow.serverName,
    serverUrl: flow.serverUrl ?? '',
    configSource: flow.configSource,
    scope: authUrl.searchParams.get('scope') ?? '',
    authorizationServer: authUrl.origin,
    redirectHost,
  });

  if (!consentGranted) throw new McpOAuthAuthorizationDeclinedError();
  await openExternal(authUrl.toString());
}

let mcpOAuthCoordinator: McpOAuthCoordinator | undefined;

export function getMcpOAuthCoordinator(): McpOAuthCoordinator {
  if (!mcpOAuthCoordinator) mcpOAuthCoordinator = new McpOAuthCoordinator();
  return mcpOAuthCoordinator;
}
