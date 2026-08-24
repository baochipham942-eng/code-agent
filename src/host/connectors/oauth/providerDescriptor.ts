import type { OAuthLoopbackRedirect } from './oauthCoordinator';

export type LoopbackRedirectUriSupport = 'confirmed' | 'pending-verification' | 'unsupported';

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
