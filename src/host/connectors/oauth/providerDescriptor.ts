import type { OAuthLoopbackRedirect } from './oauthCoordinator';

type LoopbackRedirectUriSupport = 'confirmed' | 'pending-verification' | 'unsupported';

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: Record<string, string>;
  extraAuthorizeParams?: Record<string, string>;
  redirect: OAuthLoopbackRedirect;
  loopbackRedirectUriSupport: LoopbackRedirectUriSupport;
  // 这家换 token 是否非要 App Secret 不可。飞书=true（2026-08-24 真机实测：只带 client_id
  // + PKCE 被拒，400 invalid_client / code 20140）。为 true 时缺 secret 就 fail-closed，
  // 报一句用户能照做的话，而不是把厂商那个 400 原样甩出来。
  requiresClientSecret: boolean;
  // Omitted descriptors keep using Neo's built-in OAuth coordinator. Providers backed by a
  // vendor CLI opt in explicitly so existing MCP/custom-app authorization remains unchanged.
  authMode?: 'oauth' | 'lark-cli' | 'tmeet-cli';
}

export function validateProviderDescriptor(descriptor: ProviderDescriptor): void {
  if (!descriptor.id.trim()) throw new Error('Connector OAuth provider id is required');
  if (!descriptor.clientId.trim()) {
    throw new Error(`Connector OAuth clientId is not configured for ${descriptor.id}`);
  }
  new URL(descriptor.authorizeUrl);
  new URL(descriptor.tokenUrl);
  if (descriptor.loopbackRedirectUriSupport === 'unsupported') {
    throw new Error(`Connector OAuth loopback redirect is unsupported for ${descriptor.id}`);
  }
}
