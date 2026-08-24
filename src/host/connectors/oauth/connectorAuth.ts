import {
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { ConnectorOAuthStore } from './connectorOAuthStore';
import { OAuthCoordinator } from './oauthCoordinator';
import { validateProviderDescriptor, type ProviderDescriptor } from './providerDescriptor';

const TOKEN_EXPIRY_SKEW_MS = 30_000;

export interface BeginConnectorOAuthFlowInput {
  accountId: string;
  accountLabel: string;
  descriptor: ProviderDescriptor;
  action: string;
  configSource?: string;
}

export interface ConnectorAuthOptions {
  coordinator?: OAuthCoordinator;
  storeFactory?: (accountId: string) => ConnectorOAuthStore;
  fetchFn?: FetchLike;
  now?: () => number;
}

export class ConnectorAuth {
  private readonly coordinator: OAuthCoordinator;
  private readonly storeFactory: (accountId: string) => ConnectorOAuthStore;
  private readonly fetchFn?: FetchLike;
  private readonly now: () => number;

  constructor(options: ConnectorAuthOptions = {}) {
    this.coordinator = options.coordinator ?? new OAuthCoordinator({
      openAuthorization: async () => {
        throw new Error('Connector OAuth authorization consent handler is not configured');
      },
    });
    this.storeFactory = options.storeFactory ?? ((accountId) => new ConnectorOAuthStore(accountId));
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
  }

  async beginFlow(input: BeginConnectorOAuthFlowInput): Promise<OAuthTokens> {
    const { descriptor } = input;
    validateProviderDescriptor(descriptor);
    const requestedScope = this.scopeForAction(descriptor, input.action);
    const metadata = this.metadataForDescriptor(descriptor);
    const issuer = metadata.issuer;
    const store = this.storeFactory(input.accountId);
    const clientInformation = this.clientInformationForDescriptor(descriptor, store);
    const flow = await this.coordinator.beginFlow({
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      authorizationServerIssuer: issuer,
      redirect: descriptor.redirect,
      configSource: input.configSource ?? input.action,
    });

    try {
      const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
        metadata,
        clientInformation,
        redirectUrl: flow.redirectUrl,
        scope: requestedScope,
        state: flow.state,
      });
      for (const [key, value] of Object.entries(descriptor.extraAuthorizeParams ?? {})) {
        authorizationUrl.searchParams.set(key, value);
      }

      store.saveDiscoveryState({
        authorizationServerUrl: issuer,
        authorizationServerMetadata: metadata,
      });
      store.saveClientInformation(clientInformation);
      store.saveCodeVerifier(codeVerifier);

      const callbackPromise = this.coordinator.waitForCallback(flow.flowId);
      await this.coordinator.handleAuthorizationRedirect({
        accountId: input.accountId,
        flowId: flow.flowId,
        authUrl: authorizationUrl,
      });
      const callback = await callbackPromise;
      const tokens = await exchangeAuthorization(issuer, {
        metadata,
        clientInformation,
        authorizationCode: callback.code,
        ...(callback.responseIssuer !== undefined ? { iss: callback.responseIssuer } : {}),
        codeVerifier: store.codeVerifier(),
        redirectUri: flow.redirectUrl,
        ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
      });
      store.saveTokens(tokens, requestedScope, this.now());
      store.invalidateCredentials('verifier');
      return tokens;
    } catch (error) {
      this.coordinator.cancelFlow(flow.flowId);
      throw error;
    }
  }

  async getAccessToken(accountId: string, scope: string): Promise<string> {
    if (!scope.trim()) throw new Error('Connector OAuth scope is required');
    const store = this.storeFactory(accountId);
    const stored = store.tokens();
    if (!stored) throw new Error(`Connector OAuth tokens are not available for ${accountId}`);
    if (!this.scopeIncludes(stored.tokens.scope ?? stored.requestedScope, scope)) {
      throw new Error(`Connector OAuth tokens for ${accountId} do not cover scope "${scope}"`);
    }
    if (!this.isExpired(stored.expiresAt)) return stored.tokens.access_token;

    const refreshToken = stored.tokens.refresh_token;
    if (!refreshToken) {
      throw new Error(`Connector OAuth refresh token is not available for ${accountId}`);
    }
    const discovery = store.discoveryState();
    if (!discovery) {
      throw new Error(`Connector OAuth discovery state is not available for ${accountId}`);
    }
    const clientInformation = store.clientInformation();
    if (!clientInformation) {
      throw new Error(`Connector OAuth client information is not available for ${accountId}`);
    }

    const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation,
      refreshToken,
      ...(this.fetchFn !== undefined ? { fetchFn: this.fetchFn } : {}),
    });
    store.saveTokens(refreshed, stored.requestedScope, this.now());
    return refreshed.access_token;
  }

  private scopeForAction(descriptor: ProviderDescriptor, action: string): string {
    const scope = descriptor.scopes[action]?.trim();
    if (!scope) throw new Error(`Connector OAuth action "${action}" is not configured for ${descriptor.id}`);
    return scope;
  }

  private metadataForDescriptor(descriptor: ProviderDescriptor): AuthorizationServerMetadata {
    return {
      issuer: new URL(descriptor.authorizeUrl).origin,
      authorization_endpoint: descriptor.authorizeUrl,
      token_endpoint: descriptor.tokenUrl,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  private clientInformationForDescriptor(
    descriptor: ProviderDescriptor,
    store: ConnectorOAuthStore,
  ): OAuthClientInformationMixed {
    // secret 的家是 SecureStorage（store），descriptor 上那个字段只留给测试/夹具注入。
    // 顺序刻意是 store 优先：真机凭据永远压过夹具值。
    const clientSecret = store.clientSecret() ?? descriptor.clientSecret;
    if (descriptor.requiresClientSecret && !clientSecret) {
      throw new Error(
        `${descriptor.displayName} 还没填 App Secret：请在连接设置里填好后重试`
        + `（${descriptor.id} 的 token 交换不接受只有 client_id 的公共客户端）`,
      );
    }
    return {
      client_id: descriptor.clientId,
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
    };
  }

  private isExpired(expiresAt: number | undefined): boolean {
    return expiresAt !== undefined && expiresAt <= this.now() + TOKEN_EXPIRY_SKEW_MS;
  }

  private scopeIncludes(grantedScope: string, requestedScope: string): boolean {
    const granted = new Set(grantedScope.split(/[\s,]+/u).filter(Boolean));
    return requestedScope.split(/[\s,]+/u).filter(Boolean).every((item) => granted.has(item));
  }
}
