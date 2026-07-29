import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { getSecureStorage, type SecureStorageService } from '../services/core/secureStorage';
import type { MCPHttpStreamableServerConfig } from './types';
import { getMcpOAuthCoordinator, type McpOAuthCoordinator, type McpOAuthFlow } from './mcpOAuthCoordinator';

const PRODUCT_CLIENT_NAME = 'Agent Neo';

type McpOAuthStorageKind = 'tokens' | 'client-info' | 'code-verifier' | 'discovery';
type McpOAuthStorageKey = `mcp-oauth:${string}:${string}`;
type McpOAuthCredentialScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';
type NativeOAuthClientMetadata = OAuthClientMetadata & { application_type: 'native' };

export interface McpOAuthProviderOptions {
  serverIdentity: string;
  serverName: string;
  redirectUrl: () => string;
  state: () => string | Promise<string>;
  onRedirectToAuthorization: (authUrl: URL) => void | Promise<void>;
  beforeClientMetadata?: () => void | Promise<void>;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly serverIdentity: string;
  private readonly redirectUrlResolver: () => string;
  private readonly stateResolver: () => string | Promise<string>;
  private readonly redirectHandler: (authUrl: URL) => void | Promise<void>;
  private readonly beforeClientMetadata?: () => void | Promise<void>;
  private readonly secureStorage: SecureStorageService;

  constructor(options: McpOAuthProviderOptions, secureStorage: SecureStorageService = getSecureStorage()) {
    if (!options.serverIdentity.trim()) {
      throw new Error('MCP OAuth serverIdentity is required');
    }

    this.serverIdentity = options.serverIdentity;
    this.redirectUrlResolver = options.redirectUrl;
    this.stateResolver = options.state;
    this.redirectHandler = options.onRedirectToAuthorization;
    this.beforeClientMetadata = options.beforeClientMetadata;
    this.secureStorage = secureStorage;
  }

  get redirectUrl(): string {
    return this.redirectUrlResolver();
  }

  get clientMetadata(): NativeOAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: PRODUCT_CLIENT_NAME,
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  state(): string | Promise<string> {
    return this.stateResolver();
  }

  clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined> {
    const clientInformation = this.readClientInformation();
    if (clientInformation || !this.beforeClientMetadata) return clientInformation;

    return Promise.resolve(this.beforeClientMetadata()).then(() => this.readClientInformation());
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    const issuer = this.authorizationServerIssuer();
    if (!issuer) {
      throw new Error('MCP OAuth authorization server issuer is not available');
    }
    this.secureStorage.set(this.clientInformationKey(issuer), JSON.stringify(clientInformation));
  }

  tokens(): OAuthTokens | undefined {
    return this.readJson<OAuthTokens>('tokens');
  }

  saveTokens(tokens: OAuthTokens): void {
    this.writeJson('tokens', tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.redirectHandler(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.secureStorage.set(this.keyFor('code-verifier'), codeVerifier);
  }

  codeVerifier(): string {
    const codeVerifier = this.secureStorage.get(this.keyFor('code-verifier'));
    if (!codeVerifier) {
      throw new Error('MCP OAuth code verifier is not available');
    }
    return codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const issuer = this.issuerFromDiscoveryState(state);
    this.writeJson('discovery', state);
    this.secureStorage.set(this.issuerKey(), issuer);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const state = this.readJson<OAuthDiscoveryState>('discovery');
    if (state) {
      this.secureStorage.set(this.issuerKey(), this.issuerFromDiscoveryState(state));
    }
    return state;
  }

  authorizationServerIssuer(): string | undefined {
    return this.secureStorage.get(this.issuerKey());
  }

  invalidateCredentials(scope: McpOAuthCredentialScope): void {
    const issuer = this.authorizationServerIssuer();
    const kinds = scope === 'all' ? ['tokens', 'client-info', 'code-verifier', 'discovery'] as const : [this.kindForScope(scope)];
    for (const kind of kinds) {
      if (kind === 'client-info') {
        if (issuer) {
          this.secureStorage.delete(this.clientInformationKey(issuer));
        }
        // 旧版本把 client-info 写在不带 issuer 前缀的键上。升级用户那份必须无条件一并删除，
        // 否则「退出登录」之后凭据仍残留在 SecureStorage 里；issuer 取不到时这也是唯一能删的键。
        this.secureStorage.delete(this.keyFor(kind));
      } else {
        this.secureStorage.delete(this.keyFor(kind));
      }
    }
    if (scope === 'all' || scope === 'discovery') {
      this.secureStorage.delete(this.issuerKey());
    }
  }

  private kindForScope(scope: Exclude<McpOAuthCredentialScope, 'all'>): McpOAuthStorageKind {
    switch (scope) {
      case 'client':
        return 'client-info';
      case 'verifier':
        return 'code-verifier';
      case 'tokens':
      case 'discovery':
        return scope;
    }
  }

  private keyFor(kind: McpOAuthStorageKind): McpOAuthStorageKey {
    return `mcp-oauth:${this.serverIdentity}:${kind}`;
  }

  private issuerKey(): McpOAuthStorageKey {
    return `mcp-oauth:${this.serverIdentity}:issuer`;
  }

  private clientInformationKey(issuer: string): McpOAuthStorageKey {
    return `mcp-oauth:${this.serverIdentity}:issuer:${encodeURIComponent(issuer)}:client-info`;
  }

  private readClientInformation(): OAuthClientInformationMixed | undefined {
    const issuer = this.authorizationServerIssuer();
    if (!issuer) return undefined;
    const raw = this.secureStorage.get(this.clientInformationKey(issuer));
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as OAuthClientInformationMixed;
    } catch {
      return undefined;
    }
  }

  private issuerFromDiscoveryState(state: OAuthDiscoveryState): string {
    const issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
    if (!issuer.trim()) {
      throw new Error('MCP OAuth authorization server issuer is empty');
    }
    return issuer;
  }

  private readJson<T>(kind: McpOAuthStorageKind): T | undefined {
    const raw = this.secureStorage.get(this.keyFor(kind));
    if (!raw) return undefined;

    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private writeJson(kind: McpOAuthStorageKind, value: unknown): void {
    this.secureStorage.set(this.keyFor(kind), JSON.stringify(value));
  }
}

// SDK auth() 在入口处只对 redirectUrl 做真值判断（判定 interactive flow），
// 真正取值发生在 state() 之后与 finishAuth 阶段——那时 flow 已由 ensureFlow 建立。
// 占位值必须真值且永不进入真实授权 URL / token 交换。
const OAUTH_REDIRECT_URL_PENDING = 'http://127.0.0.1/oauth-flow-pending';

export function createOAuthProviderForServer(
  config: MCPHttpStreamableServerConfig,
  serverIdentity: string,
  coordinator: McpOAuthCoordinator = getMcpOAuthCoordinator(),
): McpOAuthProvider {
  let activeFlow: McpOAuthFlow | undefined;
  let provider: McpOAuthProvider;
  const ensureFlow = async () => {
    const authorizationServerIssuer = provider.authorizationServerIssuer();
    if (!authorizationServerIssuer) {
      throw new Error('MCP OAuth authorization server issuer is not available');
    }
    activeFlow = await coordinator.beginFlow({
      serverName: config.name,
      serverIdentity,
      authorizationServerIssuer,
      serverUrl: new URL(config.serverUrl).toString(),
      ...(config.scope !== undefined ? { configSource: config.scope } : {}),
    });
    return activeFlow;
  };

  provider = new McpOAuthProvider({
    serverIdentity,
    serverName: config.name,
    redirectUrl: () => {
      return (
        activeFlow?.redirectUrl ??
        coordinator.getFlowForServerIdentity(serverIdentity)?.redirectUrl ??
        OAUTH_REDIRECT_URL_PENDING
      );
    },
    state: async () => {
      return (await ensureFlow()).state;
    },
    onRedirectToAuthorization: async (authUrl) => {
      const flow = await ensureFlow();
      await coordinator.handleAuthorizationRedirect({
        serverIdentity,
        flowId: flow.flowId,
        authUrl,
      });
    },
    beforeClientMetadata: async () => {
      await ensureFlow();
    },
  });
  return provider;
}
