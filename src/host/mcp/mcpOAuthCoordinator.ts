import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const MCP_OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
const FLOW_ID_BYTES = 16;
const STATE_BYTES = 32;
const LISTEN_MAX_ATTEMPTS = 2;

export interface BeginMcpOAuthFlowInput {
  serverName: string;
  serverIdentity: string;
  serverUrl?: string;
  configSource?: string;
}

export interface McpOAuthFlow {
  flowId: string;
  serverName: string;
  serverIdentity: string;
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

interface FlowRecord extends McpOAuthFlow {
  server: Server;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve: (result: McpOAuthCallbackResult) => void;
  reject: (error: Error) => void;
  callbackPromise: Promise<McpOAuthCallbackResult>;
}

export class McpOAuthCoordinator {
  private readonly timeoutMs: number;
  private readonly openAuthorization: (authUrl: URL, flow: McpOAuthFlow) => void | Promise<void>;
  private readonly flowsById = new Map<string, FlowRecord>();
  private readonly flowsByIdentity = new Map<string, FlowRecord>();
  private readonly pendingBegins = new Map<string, Promise<McpOAuthFlow>>();

  constructor(options: McpOAuthCoordinatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? MCP_OAUTH_FLOW_TIMEOUT_MS;
    this.openAuthorization = options.openAuthorization ?? openAuthorizationWithConsent;
  }

  async beginFlow(input: BeginMcpOAuthFlowInput): Promise<McpOAuthFlow> {
    const existing = this.flowsByIdentity.get(input.serverIdentity);
    if (existing) return this.snapshot(existing);

    const pending = this.pendingBegins.get(input.serverIdentity);
    if (pending) return pending;

    const begin = this.createFlow(input).finally(() => {
      this.pendingBegins.delete(input.serverIdentity);
    });
    this.pendingBegins.set(input.serverIdentity, begin);
    return begin;
  }

  getRedirectUrl(serverIdentity: string): string {
    const flow = this.flowsByIdentity.get(serverIdentity);
    if (!flow) {
      throw new Error(`MCP OAuth flow is not active for ${serverIdentity}`);
    }
    return flow.redirectUrl;
  }

  getFlowForServerIdentity(serverIdentity: string): McpOAuthFlow | undefined {
    const flow = this.flowsByIdentity.get(serverIdentity);
    return flow ? this.snapshot(flow) : undefined;
  }

  async handleAuthorizationRedirect(input: {
    serverIdentity: string;
    flowId?: string;
    authUrl: URL;
  }): Promise<void> {
    const flow = input.flowId
      ? this.flowsById.get(input.flowId)
      : this.flowsByIdentity.get(input.serverIdentity);
    if (flow?.serverIdentity !== input.serverIdentity) {
      throw new Error(`MCP OAuth flow is not active for ${input.serverIdentity}`);
    }

    flow.authorizationUrl = input.authUrl.toString();
    try {
      await this.openAuthorization(input.authUrl, this.snapshot(flow));
    } catch (error) {
      this.cancelFlow(flow.flowId);
      throw error;
    }
  }

  waitForCallback(flowId: string): Promise<McpOAuthCallbackResult> {
    const flow = this.flowsById.get(flowId);
    if (!flow) {
      return Promise.reject(new Error(`MCP OAuth flow is not active: ${flowId}`));
    }
    return flow.callbackPromise;
  }

  cancelFlow(flowId: string): boolean {
    const flow = this.flowsById.get(flowId);
    if (!flow) return false;
    this.failFlow(flow, new Error('MCP OAuth flow cancelled'));
    return true;
  }

  cancelFlowForServerIdentity(serverIdentity: string): boolean {
    const flow = this.flowsByIdentity.get(serverIdentity);
    if (!flow) return false;
    this.failFlow(flow, new Error('MCP OAuth flow cancelled'));
    return true;
  }

  cancelAll(): void {
    for (const flow of Array.from(this.flowsById.values())) {
      this.failFlow(flow, new Error('MCP OAuth flow cancelled'));
    }
  }

  private async createFlow(input: BeginMcpOAuthFlowInput): Promise<McpOAuthFlow> {
    const flowId = randomBytes(FLOW_ID_BYTES).toString('hex');
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const recordRef: { current?: FlowRecord } = {};
    let resolve!: (result: McpOAuthCallbackResult) => void;
    let reject!: (error: Error) => void;
    const callbackPromise = new Promise<McpOAuthCallbackResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    callbackPromise.catch(() => {});

    const { server, redirectUrl } = await this.createLoopbackServer((req, res) => {
      const record = recordRef.current;
      if (!record) {
        this.sendText(res, 503, 'OAuth flow is not ready');
        return;
      }
      this.handleCallbackRequest(record, req, res);
    });

    const timeout = setTimeout(() => {
      const record = recordRef.current;
      if (record) {
        this.failFlow(record, new Error('MCP OAuth flow timed out'));
      }
    }, this.timeoutMs);
    timeout.unref?.();

    const record: FlowRecord = {
      flowId,
      serverName: input.serverName,
      serverIdentity: input.serverIdentity,
      ...(input.serverUrl !== undefined ? { serverUrl: input.serverUrl } : {}),
      ...(input.configSource !== undefined ? { configSource: input.configSource } : {}),
      state,
      redirectUrl,
      server,
      timeout,
      settled: false,
      resolve,
      reject,
      callbackPromise,
    };
    recordRef.current = record;
    this.flowsById.set(flowId, record);
    this.flowsByIdentity.set(input.serverIdentity, record);
    return this.snapshot(record);
  }

  private async createLoopbackServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; redirectUrl: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LISTEN_MAX_ATTEMPTS; attempt += 1) {
      const server = createServer(handler);
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(0, LOOPBACK_HOST);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('MCP OAuth loopback server did not expose a TCP address');
        }
        return {
          server,
          redirectUrl: `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`,
        };
      } catch (error) {
        lastError = error;
        this.closeServer(server);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private handleCallbackRequest(flow: FlowRecord, req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      this.sendText(res, 404, 'Not found');
      return;
    }

    const requestUrl = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (requestUrl.pathname !== CALLBACK_PATH) {
      this.sendText(res, 404, 'Not found');
      return;
    }

    if (requestUrl.searchParams.get('state') !== flow.state) {
      this.sendText(res, 400, 'Invalid OAuth state');
      return;
    }

    const code = requestUrl.searchParams.get('code');
    if (!code) {
      this.sendText(res, 400, 'Missing OAuth code');
      return;
    }

    // 重放防护 = state 保密性 + promise 单次 resolve(重复 resolve 是 no-op)
    // + settle 后立即关闭 server 并销毁存量连接。
    flow.settled = true;
    flow.resolve({
      flowId: flow.flowId,
      serverName: flow.serverName,
      serverIdentity: flow.serverIdentity,
      state: flow.state,
      code,
    });
    res.once('finish', () => this.cleanupFlow(flow));
    this.sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><title>Authorization complete</title><p>Authorization complete. You can close this page.</p><p>授权完成，可以关闭此页。</p>');
  }

  private failFlow(flow: FlowRecord, error: Error): void {
    if (flow.settled) return;
    flow.settled = true;
    flow.reject(error);
    this.cleanupFlow(flow);
  }

  private cleanupFlow(flow: FlowRecord): void {
    clearTimeout(flow.timeout);
    if (this.flowsById.get(flow.flowId) === flow) {
      this.flowsById.delete(flow.flowId);
    }
    if (this.flowsByIdentity.get(flow.serverIdentity) === flow) {
      this.flowsByIdentity.delete(flow.serverIdentity);
    }
    this.closeServer(flow.server);
  }

  private closeServer(server: Server): void {
    try {
      server.close(() => {});
      server.closeAllConnections();
    } catch {
      // The server may already be closed by a prior cleanup path.
    }
  }

  private snapshot(flow: FlowRecord): McpOAuthFlow {
    return {
      flowId: flow.flowId,
      serverName: flow.serverName,
      serverIdentity: flow.serverIdentity,
      ...(flow.serverUrl !== undefined ? { serverUrl: flow.serverUrl } : {}),
      ...(flow.configSource !== undefined ? { configSource: flow.configSource } : {}),
      state: flow.state,
      redirectUrl: flow.redirectUrl,
      ...(flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : {}),
    };
  }

  private sendText(res: ServerResponse, statusCode: number, body: string): void {
    res.writeHead(statusCode, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  private sendHtml(res: ServerResponse, statusCode: number, body: string): void {
    res.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }
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

  if (!consentGranted) {
    throw new McpOAuthAuthorizationDeclinedError();
  }

  await openExternal(authUrl.toString());
}

let mcpOAuthCoordinator: McpOAuthCoordinator | undefined;

export function getMcpOAuthCoordinator(): McpOAuthCoordinator {
  if (!mcpOAuthCoordinator) {
    mcpOAuthCoordinator = new McpOAuthCoordinator();
  }
  return mcpOAuthCoordinator;
}
