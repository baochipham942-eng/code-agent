import { ConnectorAuth } from './connectorAuth';
import { ConnectorOAuthStore } from './connectorOAuthStore';
import { FEISHU_OAUTH_DESCRIPTOR } from './feishuOAuth';
import { GOOGLE_CALENDAR_OAUTH_DESCRIPTOR } from './googleCalendarOAuth';
import {
  validateProviderDescriptor,
  type LoopbackRedirectUriSupport,
  type ProviderDescriptor,
} from './providerDescriptor';

const CUSTOM_OAUTH_PROVIDER_ID = 'custom-oauth';

const TMEET_DESCRIPTOR: ProviderDescriptor = {
  id: 'tmeet',
  displayName: '腾讯会议',
  authorizeUrl: 'https://meeting.tencent.com',
  tokenUrl: 'https://meeting.tencent.com',
  clientId: 'tmeet-cli',
  scopes: { 'meeting.create': 'meeting' },
  redirect: { mode: 'loopback-random' },
  loopbackRedirectUriSupport: 'confirmed',
  requiresClientSecret: false,
  authMode: 'tmeet-cli',
};

const STATIC_OAUTH_PROVIDERS = [
  FEISHU_OAUTH_DESCRIPTOR,
  GOOGLE_CALENDAR_OAUTH_DESCRIPTOR,
  TMEET_DESCRIPTOR,
] as const;

export interface CustomOAuthDescriptorInput {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  requiresClientSecret: boolean;
  loopbackRedirectUriSupport: LoopbackRedirectUriSupport;
}

export function listOAuthProviderDescriptors(): ProviderDescriptor[] {
  const custom = new ConnectorOAuthStore(CUSTOM_OAUTH_PROVIDER_ID).descriptor();
  return [...STATIC_OAUTH_PROVIDERS, ...(custom ? [custom] : [])];
}

export function getOAuthProviderDescriptor(providerId: string | undefined): ProviderDescriptor | undefined {
  return providerId
    ? listOAuthProviderDescriptors().find((descriptor) => descriptor.id === providerId)
    : undefined;
}

export function saveCustomOAuthProviderDescriptor(input: CustomOAuthDescriptorInput): ProviderDescriptor {
  const authorizeUrl = new URL(input.authorizeUrl.trim());
  const tokenUrl = new URL(input.tokenUrl.trim());
  const descriptor: ProviderDescriptor = {
    id: CUSTOM_OAUTH_PROVIDER_ID,
    displayName: authorizeUrl.hostname,
    authorizeUrl: authorizeUrl.toString(),
    tokenUrl: tokenUrl.toString(),
    clientId: input.clientId.trim(),
    scopes: { 'http.request': '' },
    apiHosts: [tokenUrl.hostname.toLowerCase()],
    httpRequestScope: '',
    redirect: { mode: 'loopback-random' },
    loopbackRedirectUriSupport: input.loopbackRedirectUriSupport,
    requiresClientSecret: input.requiresClientSecret,
    authMode: 'oauth',
  };
  validateProviderDescriptor(descriptor);

  const store = new ConnectorOAuthStore(CUSTOM_OAUTH_PROVIDER_ID);
  const previous = store.descriptor();
  if (previous && JSON.stringify(previous) !== JSON.stringify(descriptor)) {
    store.invalidateCredentials('all');
  }
  store.saveDescriptor(descriptor);
  return descriptor;
}

export function findConnectedOAuthProviderForHost(hostname: string): ProviderDescriptor | undefined {
  const normalizedHost = hostname.trim().toLowerCase();
  return listOAuthProviderDescriptors().find((descriptor) => (
    (descriptor.authMode ?? 'oauth') === 'oauth'
    && descriptor.apiHosts?.some((host) => host.toLowerCase() === normalizedHost)
    && Boolean(new ConnectorOAuthStore(descriptor.id).tokens())
  ));
}

export async function getOAuthAuthorizationHeader(descriptor: ProviderDescriptor): Promise<string> {
  const scope = descriptor.httpRequestScope ?? Object.values(descriptor.scopes)[0] ?? '';
  const accessToken = await new ConnectorAuth().getAccessToken(descriptor.id, scope);
  const tokenType = new ConnectorOAuthStore(descriptor.id).tokens()?.tokens.token_type?.trim() || 'Bearer';
  return `${tokenType} ${accessToken}`;
}
