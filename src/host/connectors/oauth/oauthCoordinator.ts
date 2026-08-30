import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('OAuthCoordinator', { lane: 'mcp' });

export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
const FLOW_ID_BYTES = 16;
const STATE_BYTES = 32;
const RANDOM_LISTEN_MAX_ATTEMPTS = 2;

export type OAuthLoopbackRedirect =
  | { mode: 'loopback-random' }
  | { mode: 'loopback-fixed'; port: number };

export interface BeginOAuthFlowInput {
  accountLabel: string;
  accountId: string;
  authorizationServerIssuer: string;
  redirect: OAuthLoopbackRedirect;
  resourceUrl?: string;
  configSource?: string;
}

export interface OAuthFlow {
  flowId: string;
  accountLabel: string;
  accountId: string;
  authorizationServerIssuer: string;
  redirect: OAuthLoopbackRedirect;
  resourceUrl?: string;
  configSource?: string;
  state: string;
  redirectUrl: string;
  authorizationUrl?: string;
}

export interface OAuthCallbackResult {
  flowId: string;
  accountLabel: string;
  accountId: string;
  state: string;
  code: string;
  responseIssuer?: string;
}

export interface OAuthCoordinatorMessages {
  inactiveForAccount: (accountId: string) => string;
  inactiveFlow: (flowId: string) => string;
  cancelled: string;
  timedOut: string;
  issuerMismatch: (expected: string, received: string) => string;
  loopbackAddressUnavailable: string;
}

const DEFAULT_MESSAGES: OAuthCoordinatorMessages = {
  inactiveForAccount: (accountId) => `OAuth flow is not active for ${accountId}`,
  inactiveFlow: (flowId) => `OAuth flow is not active: ${flowId}`,
  cancelled: 'OAuth flow cancelled',
  timedOut: 'OAuth flow timed out',
  issuerMismatch: (expected, received) =>
    `OAuth issuer mismatch: expected "${expected}", received "${received}"`,
  loopbackAddressUnavailable: 'OAuth loopback server did not expose a TCP address',
};

export interface OAuthCoordinatorOptions {
  timeoutMs?: number;
  openAuthorization: (authUrl: URL, flow: OAuthFlow) => void | Promise<void>;
  messages?: OAuthCoordinatorMessages;
}

interface FlowRecord extends OAuthFlow {
  server: Server;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve: (result: OAuthCallbackResult) => void;
  reject: (error: Error) => void;
  callbackPromise: Promise<OAuthCallbackResult>;
}

export class OAuthCoordinator {
  private readonly timeoutMs: number;
  private readonly openAuthorization: OAuthCoordinatorOptions['openAuthorization'];
  private readonly messages: OAuthCoordinatorMessages;
  private readonly flowsById = new Map<string, FlowRecord>();
  private readonly flowsByAccountId = new Map<string, FlowRecord>();
  private readonly pendingBegins = new Map<string, Promise<OAuthFlow>>();

  constructor(options: OAuthCoordinatorOptions) {
    this.timeoutMs = options.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
    this.openAuthorization = options.openAuthorization;
    this.messages = options.messages ?? DEFAULT_MESSAGES;
  }

  async beginFlow(input: BeginOAuthFlowInput): Promise<OAuthFlow> {
    const existing = this.flowsByAccountId.get(input.accountId);
    if (existing) {
      logger.info('Reusing active OAuth loopback listener', {
        accountId: input.accountId,
        flowId: existing.flowId,
      });
      return this.snapshot(existing);
    }

    const pending = this.pendingBegins.get(input.accountId);
    if (pending) return pending;

    const begin = this.createFlow(input).finally(() => {
      this.pendingBegins.delete(input.accountId);
    });
    this.pendingBegins.set(input.accountId, begin);
    return begin;
  }

  getRedirectUrl(accountId: string): string {
    const flow = this.flowsByAccountId.get(accountId);
    if (!flow) throw new Error(this.messages.inactiveForAccount(accountId));
    return flow.redirectUrl;
  }

  getFlowForAccountId(accountId: string): OAuthFlow | undefined {
    const flow = this.flowsByAccountId.get(accountId);
    return flow ? this.snapshot(flow) : undefined;
  }

  async handleAuthorizationRedirect(input: {
    accountId: string;
    flowId?: string;
    authUrl: URL;
  }): Promise<void> {
    const flow = input.flowId
      ? this.flowsById.get(input.flowId)
      : this.flowsByAccountId.get(input.accountId);
    if (flow?.accountId !== input.accountId) {
      throw new Error(this.messages.inactiveForAccount(input.accountId));
    }

    flow.authorizationUrl = input.authUrl.toString();
    try {
      logger.info('Opening OAuth authorization page', {
        accountId: flow.accountId,
        flowId: flow.flowId,
        authorizationHost: input.authUrl.hostname,
      });
      await this.openAuthorization(input.authUrl, this.snapshot(flow));
    } catch (error) {
      logger.error('Failed to open OAuth authorization page', {
        accountId: flow.accountId,
        flowId: flow.flowId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cancelFlow(flow.flowId);
      throw error;
    }
  }

  waitForCallback(flowId: string): Promise<OAuthCallbackResult> {
    const flow = this.flowsById.get(flowId);
    if (!flow) return Promise.reject(new Error(this.messages.inactiveFlow(flowId)));
    return flow.callbackPromise;
  }

  cancelFlow(flowId: string): boolean {
    const flow = this.flowsById.get(flowId);
    if (!flow) return false;
    this.failFlow(flow, new Error(this.messages.cancelled));
    return true;
  }

  cancelFlowForAccountId(accountId: string): boolean {
    const flow = this.flowsByAccountId.get(accountId);
    if (!flow) return false;
    this.failFlow(flow, new Error(this.messages.cancelled));
    return true;
  }

  cancelAll(): void {
    for (const flow of Array.from(this.flowsById.values())) {
      this.failFlow(flow, new Error(this.messages.cancelled));
    }
  }

  private async createFlow(input: BeginOAuthFlowInput): Promise<OAuthFlow> {
    this.validateRedirect(input.redirect);
    const flowId = randomBytes(FLOW_ID_BYTES).toString('hex');
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const recordRef: { current?: FlowRecord } = {};
    let resolve!: (result: OAuthCallbackResult) => void;
    let reject!: (error: Error) => void;
    const callbackPromise = new Promise<OAuthCallbackResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void callbackPromise.catch((error) => {
      logger.warn('OAuth callback waiter rejected', {
        accountId: input.accountId,
        flowId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info('Starting OAuth loopback listener', {
      accountId: input.accountId,
      flowId,
      redirectMode: input.redirect.mode,
    });

    const { server, redirectUrl } = await this.createLoopbackServer(input.redirect, (req, res) => {
      const record = recordRef.current;
      if (!record) {
        this.sendText(res, 503, 'OAuth flow is not ready');
        return;
      }
      this.handleCallbackRequest(record, req, res);
    });

    const timeout = setTimeout(() => {
      const record = recordRef.current;
      if (record) this.failFlow(record, new Error(this.messages.timedOut));
    }, this.timeoutMs);
    timeout.unref?.();

    const record: FlowRecord = {
      flowId,
      accountLabel: input.accountLabel,
      accountId: input.accountId,
      authorizationServerIssuer: input.authorizationServerIssuer,
      redirect: input.redirect,
      ...(input.resourceUrl !== undefined ? { resourceUrl: input.resourceUrl } : {}),
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
    this.flowsByAccountId.set(input.accountId, record);
    const callbackUrl = new URL(record.redirectUrl);
    logger.info('OAuth loopback listener ready', {
      accountId: input.accountId,
      flowId,
      host: callbackUrl.hostname,
      port: callbackUrl.port,
      path: callbackUrl.pathname,
    });
    return this.snapshot(record);
  }

  private async createLoopbackServer(
    redirect: OAuthLoopbackRedirect,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; redirectUrl: string }> {
    const port = redirect.mode === 'loopback-fixed' ? redirect.port : 0;
    const attempts = redirect.mode === 'loopback-fixed' ? 1 : RANDOM_LISTEN_MAX_ATTEMPTS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
          server.listen(port, LOOPBACK_HOST);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error(this.messages.loopbackAddressUnavailable);
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
    logger.info('Received OAuth loopback request', {
      accountId: flow.accountId,
      flowId: flow.flowId,
      method: req.method ?? 'unknown',
    });
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
      logger.warn('Rejected OAuth callback with invalid state', {
        accountId: flow.accountId,
        flowId: flow.flowId,
      });
      this.sendText(res, 400, 'Invalid OAuth state');
      return;
    }

    const responseIssuer = requestUrl.searchParams.get('iss');
    if (responseIssuer !== null && responseIssuer !== flow.authorizationServerIssuer) {
      const error = new Error(
        this.messages.issuerMismatch(flow.authorizationServerIssuer, responseIssuer),
      );
      flow.settled = true;
      flow.reject(error);
      logger.warn('Rejected OAuth callback with mismatched issuer', {
        accountId: flow.accountId,
        flowId: flow.flowId,
      });
      res.once('finish', () => this.cleanupFlow(flow));
      this.sendText(res, 400, error.message);
      return;
    }

    const code = requestUrl.searchParams.get('code');
    if (!code) {
      logger.warn('Rejected OAuth callback without authorization code', {
        accountId: flow.accountId,
        flowId: flow.flowId,
      });
      this.sendText(res, 400, 'Missing OAuth code');
      return;
    }

    flow.settled = true;
    logger.info('Accepted OAuth callback', {
      accountId: flow.accountId,
      flowId: flow.flowId,
      responseIssuerPresent: responseIssuer !== null,
    });
    flow.resolve({
      flowId: flow.flowId,
      accountLabel: flow.accountLabel,
      accountId: flow.accountId,
      state: flow.state,
      code,
      ...(responseIssuer !== null ? { responseIssuer } : {}),
    });
    res.once('finish', () => this.cleanupFlow(flow));
    this.sendHtml(
      res,
      200,
      '<!doctype html><meta charset="utf-8"><title>Authorization complete</title><p>Authorization complete. You can close this page.</p><p>授权完成，可以关闭此页。</p>',
    );
  }

  private failFlow(flow: FlowRecord, error: Error): void {
    if (flow.settled) return;
    flow.settled = true;
    logger.warn('OAuth flow failed before callback completion', {
      accountId: flow.accountId,
      flowId: flow.flowId,
      error: error.message,
    });
    flow.reject(error);
    this.cleanupFlow(flow);
  }

  private cleanupFlow(flow: FlowRecord): void {
    clearTimeout(flow.timeout);
    if (this.flowsById.get(flow.flowId) === flow) this.flowsById.delete(flow.flowId);
    if (this.flowsByAccountId.get(flow.accountId) === flow) {
      this.flowsByAccountId.delete(flow.accountId);
    }
    this.closeServer(flow.server);
  }

  private closeServer(server: Server): void {
    try {
      server.close((error) => {
        if (error) logger.debug('OAuth loopback listener close reported an error', { error: error.message });
      });
      server.closeAllConnections();
    } catch (error) {
      logger.debug('OAuth loopback listener was already closed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private snapshot(flow: FlowRecord): OAuthFlow {
    return {
      flowId: flow.flowId,
      accountLabel: flow.accountLabel,
      accountId: flow.accountId,
      authorizationServerIssuer: flow.authorizationServerIssuer,
      redirect: flow.redirect,
      ...(flow.resourceUrl !== undefined ? { resourceUrl: flow.resourceUrl } : {}),
      ...(flow.configSource !== undefined ? { configSource: flow.configSource } : {}),
      state: flow.state,
      redirectUrl: flow.redirectUrl,
      ...(flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : {}),
    };
  }

  private validateRedirect(redirect: OAuthLoopbackRedirect): void {
    if (
      redirect.mode === 'loopback-fixed'
      && (!Number.isInteger(redirect.port) || redirect.port < 1 || redirect.port > 65_535)
    ) {
      throw new Error(`OAuth loopback port is invalid: ${redirect.port}`);
    }
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
