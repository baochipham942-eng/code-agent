import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { getSecureStorage, type SecureStorageService } from '../../services/core/secureStorage';
import { validateProviderDescriptor, type ProviderDescriptor } from './providerDescriptor';

type ConnectorOAuthStorageKind =
  | 'tokens'
  | 'client-info'
  | 'code-verifier'
  | 'discovery'
  | 'client-secret'
  | 'descriptor';
type ConnectorOAuthStorageKey = `connector-oauth:${string}:${string}`;
export type ConnectorOAuthCredentialScope =
  | 'all'
  | 'client'
  | 'tokens'
  | 'verifier'
  | 'discovery'
  | 'client-secret';

export interface ConnectorOAuthDiscoveryState {
  authorizationServerUrl: string;
  authorizationServerMetadata?: AuthorizationServerMetadata;
}

export interface StoredConnectorOAuthTokens {
  tokens: OAuthTokens;
  issuer: string;
  requestedScope: string;
  expiresAt?: number;
}

export class ConnectorOAuthStore {
  private readonly accountId: string;
  private readonly secureStorage: SecureStorageService;

  constructor(accountId: string, secureStorage: SecureStorageService = getSecureStorage()) {
    if (!accountId.trim()) throw new Error('Connector OAuth accountId is required');
    this.accountId = accountId;
    this.secureStorage = secureStorage;
  }

  tokens(): StoredConnectorOAuthTokens | undefined {
    return this.readJson<StoredConnectorOAuthTokens>('tokens');
  }

  saveTokens(tokens: OAuthTokens, requestedScope: string, nowMs = Date.now()): void {
    const issuer = this.authorizationServerIssuer();
    if (!issuer) throw new Error('Connector OAuth authorization server issuer is not available');
    const expiresAt = this.resolveExpiresAt(tokens.expires_in, nowMs);
    this.writeJson('tokens', {
      tokens,
      issuer,
      requestedScope,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    } satisfies StoredConnectorOAuthTokens);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const issuer = this.authorizationServerIssuer();
    if (!issuer) return undefined;
    return this.readJsonFromKey<OAuthClientInformationMixed>(this.clientInformationKey(issuer));
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    const issuer = this.authorizationServerIssuer();
    if (!issuer) throw new Error('Connector OAuth authorization server issuer is not available');
    this.secureStorage.set(this.clientInformationKey(issuer), JSON.stringify(clientInformation));
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.secureStorage.set(this.keyFor('code-verifier'), codeVerifier);
  }

  codeVerifier(): string {
    const codeVerifier = this.secureStorage.get(this.keyFor('code-verifier'));
    if (!codeVerifier) throw new Error('Connector OAuth code verifier is not available');
    return codeVerifier;
  }

  saveDiscoveryState(state: ConnectorOAuthDiscoveryState): void {
    const issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
    if (!issuer.trim()) throw new Error('Connector OAuth authorization server issuer is empty');
    this.writeJson('discovery', state);
    this.secureStorage.set(this.issuerKey(), issuer);
  }

  discoveryState(): ConnectorOAuthDiscoveryState | undefined {
    const state = this.readJson<ConnectorOAuthDiscoveryState>('discovery');
    if (state) {
      const issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
      if (issuer.trim()) this.secureStorage.set(this.issuerKey(), issuer);
    }
    return state;
  }

  // provider 的 App Secret。**只住在这里**——不进安装包、不落配置文件、不进 git。
  // 飞书这条路非要它不可：2026-08-24 真机实测，只带 client_id + PKCE 换 token 会被拒
  // （400 invalid_client / code 20140）。
  clientSecret(): string | undefined {
    return this.secureStorage.get(this.keyFor('client-secret')) || undefined;
  }

  saveClientSecret(clientSecret: string): void {
    if (!clientSecret.trim()) {
      throw new Error('Connector OAuth client secret must not be empty');
    }
    this.secureStorage.set(this.keyFor('client-secret'), clientSecret.trim());
  }

  descriptor(): ProviderDescriptor | undefined {
    const descriptor = this.readJson<ProviderDescriptor>('descriptor');
    if (!descriptor) return undefined;
    try {
      validateProviderDescriptor(descriptor);
      return descriptor;
    } catch {
      return undefined;
    }
  }

  saveDescriptor(descriptor: ProviderDescriptor): void {
    validateProviderDescriptor(descriptor);
    if (descriptor.id !== this.accountId) {
      throw new Error(`Connector OAuth descriptor id must match accountId ${this.accountId}`);
    }
    const { clientSecret: _clientSecret, ...persistable } = descriptor;
    this.writeJson('descriptor', persistable);
  }

  authorizationServerIssuer(): string | undefined {
    return this.secureStorage.get(this.issuerKey());
  }

  invalidateCredentials(scope: ConnectorOAuthCredentialScope): void {
    const issuer = this.authorizationServerIssuer();
    const kinds = scope === 'all'
      ? ['tokens', 'client-info', 'code-verifier', 'discovery', 'client-secret'] as const
      : [this.kindForScope(scope)];
    for (const kind of kinds) {
      if (kind === 'client-info') {
        if (issuer) this.secureStorage.delete(this.clientInformationKey(issuer));
        this.secureStorage.delete(this.keyFor(kind));
      } else {
        this.secureStorage.delete(this.keyFor(kind));
      }
    }
    if (scope === 'all' || scope === 'discovery') this.secureStorage.delete(this.issuerKey());
  }

  private kindForScope(
    scope: Exclude<ConnectorOAuthCredentialScope, 'all'>,
  ): ConnectorOAuthStorageKind {
    switch (scope) {
      case 'client':
        return 'client-info';
      case 'verifier':
        return 'code-verifier';
      case 'client-secret':
        return 'client-secret';
      case 'tokens':
      case 'discovery':
        return scope;
    }
  }

  private resolveExpiresAt(expiresIn: number | undefined, nowMs: number): number | undefined {
    if (expiresIn === undefined || !Number.isFinite(expiresIn)) return undefined;
    return nowMs + Math.max(0, expiresIn) * 1000;
  }

  private keyFor(kind: ConnectorOAuthStorageKind): ConnectorOAuthStorageKey {
    return `connector-oauth:${this.accountId}:${kind}`;
  }

  private issuerKey(): ConnectorOAuthStorageKey {
    return `connector-oauth:${this.accountId}:issuer`;
  }

  private clientInformationKey(issuer: string): ConnectorOAuthStorageKey {
    return `connector-oauth:${this.accountId}:issuer:${encodeURIComponent(issuer)}:client-info`;
  }

  private readJson<T>(kind: ConnectorOAuthStorageKind): T | undefined {
    return this.readJsonFromKey<T>(this.keyFor(kind));
  }

  private readJsonFromKey<T>(key: ConnectorOAuthStorageKey): T | undefined {
    const raw = this.secureStorage.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private writeJson(kind: ConnectorOAuthStorageKind, value: unknown): void {
    this.secureStorage.set(this.keyFor(kind), JSON.stringify(value));
  }
}
