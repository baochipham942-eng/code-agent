import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getSecureStorage, type SecureStorageService } from '../services/core/secureStorage';
import type { MCPHttpStreamableServerConfig } from './types';
import { getMcpOAuthCoordinator, type McpOAuthCoordinator, type McpOAuthFlow } from './mcpOAuthCoordinator';

const PRODUCT_CLIENT_NAME = 'Agent Neo';

type McpOAuthStorageKind = 'tokens' | 'client-info' | 'code-verifier' | 'discovery';
type McpOAuthStorageKey = `mcp-oauth:${string}:${McpOAuthStorageKind}`;
type McpOAuthCredentialScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';

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

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: PRODUCT_CLIENT_NAME,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  state(): string | Promise<string> {
    return this.stateResolver();
  }

  clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined> {
    const clientInformation = this.readJson<OAuthClientInformationMixed>('client-info');
    if (clientInformation || !this.beforeClientMetadata) return clientInformation;

    return Promise.resolve(this.beforeClientMetadata()).then(() => this.readJson<OAuthClientInformationMixed>('client-info'));
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.writeJson('client-info', clientInformation);
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
    this.writeJson('discovery', state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.readJson<OAuthDiscoveryState>('discovery');
  }

  invalidateCredentials(scope: McpOAuthCredentialScope): void {
    const kinds = scope === 'all' ? ['tokens', 'client-info', 'code-verifier', 'discovery'] as const : [this.kindForScope(scope)];
    for (const kind of kinds) {
      this.secureStorage.delete(this.keyFor(kind));
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
  const ensureFlow = async () => {
    activeFlow = await coordinator.beginFlow({
      serverName: config.name,
      serverIdentity,
    });
    return activeFlow;
  };

  return new McpOAuthProvider({
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
}
