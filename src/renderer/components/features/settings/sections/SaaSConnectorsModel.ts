import { CLI_CONNECTOR_DESCRIPTORS } from '@shared/constants/cliConnectorDescriptors';
import type { useI18n } from '../../../../hooks/useI18n';
import { getInstallErrorPresentation } from './SaaSConnectorInstallError';

type LoopbackRedirectUriSupport = 'confirmed' | 'pending-verification' | 'unsupported';
type ConnectorAuthMode = 'oauth' | 'lark-cli' | 'tmeet-cli';

const CLI_LOGO_BY_PROVIDER = new Map(CLI_CONNECTOR_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.logo]));

interface ConnectorOAuthProviderStatus {
  id: string;
  displayName: string;
  clientIdConfigured: boolean;
  requiresClientSecret: boolean;
  clientSecretConfigured: boolean;
  connected: boolean;
  loopbackRedirectUriSupport: LoopbackRedirectUriSupport;
  authMode: ConnectorAuthMode;
  step?: 1 | 2;
  authorizationOpened?: boolean;
  blocked?: boolean;
  stale?: boolean;
  installState?: 'failed';
  userName?: string;
  tenantName?: string;
}

type ProviderPresentationState =
  | 'missing_client_id'
  | 'needs_secret'
  | 'ready'
  | 'connecting_step_1'
  | 'connecting_step_2'
  | 'connecting_single'
  | 'connected'
  | 'admin_blocked'
  | 'install_error'
  | 'unavailable';

type SaaSConnectorsText = ReturnType<typeof useI18n>['t']['settings']['saasConnectors'];

const CONNECT_ACTION_BY_PROVIDER: Readonly<Record<string, string>> = {
  feishu: 'message.send-as-user',
  'google-calendar': 'calendar.events',
  tmeet: 'meeting.create',
  'custom-oauth': 'http.request',
};

const LOOPBACK_SUPPORT_VALUES = new Set<LoopbackRedirectUriSupport>([
  'confirmed',
  'pending-verification',
  'unsupported',
]);
const AUTH_MODE_VALUES = new Set<ConnectorAuthMode>(['oauth', 'lark-cli', 'tmeet-cli']);
const STATUS_CACHE_STORAGE_KEY = 'code-agent:connector-oauth-statuses';

function isCliAuthMode(authMode: ConnectorAuthMode): boolean {
  return authMode === 'lark-cli' || authMode === 'tmeet-cli';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseProviderStatus(value: unknown): ConnectorOAuthProviderStatus | null {
  if (!isRecord(value)) return null;

  const {
    id,
    displayName,
    clientIdConfigured,
    requiresClientSecret,
    clientSecretConfigured,
    connected,
    loopbackRedirectUriSupport,
    authMode,
    step,
    authorizationOpened,
    blocked,
    stale,
    installState,
    userName,
    tenantName,
  } = value;

  if (
    typeof id !== 'string'
    || !id.trim()
    || typeof displayName !== 'string'
    || !displayName.trim()
    || typeof clientIdConfigured !== 'boolean'
    || typeof requiresClientSecret !== 'boolean'
    || typeof clientSecretConfigured !== 'boolean'
    || typeof connected !== 'boolean'
    || typeof loopbackRedirectUriSupport !== 'string'
    || !LOOPBACK_SUPPORT_VALUES.has(loopbackRedirectUriSupport as LoopbackRedirectUriSupport)
    || typeof authMode !== 'string'
    || !AUTH_MODE_VALUES.has(authMode as ConnectorAuthMode)
    || (step !== undefined && step !== 1 && step !== 2)
    || (authorizationOpened !== undefined && typeof authorizationOpened !== 'boolean')
    || (blocked !== undefined && typeof blocked !== 'boolean')
    || (stale !== undefined && typeof stale !== 'boolean')
    || (installState !== undefined && installState !== 'failed')
    || (userName !== undefined && typeof userName !== 'string')
    || (tenantName !== undefined && typeof tenantName !== 'string')
  ) {
    return null;
  }

  return {
    id,
    displayName,
    clientIdConfigured,
    requiresClientSecret,
    clientSecretConfigured,
    connected,
    loopbackRedirectUriSupport: loopbackRedirectUriSupport as LoopbackRedirectUriSupport,
    authMode: authMode as ConnectorAuthMode,
    ...(step === 1 || step === 2 ? { step } : {}),
    ...(authorizationOpened === true ? { authorizationOpened: true } : {}),
    ...(typeof blocked === 'boolean' ? { blocked } : {}),
    ...(stale === true ? { stale: true } : {}),
    ...(installState === 'failed' ? { installState } : {}),
    ...(typeof userName === 'string' && userName.trim() ? { userName } : {}),
    ...(typeof tenantName === 'string' && tenantName.trim() ? { tenantName } : {}),
  };
}

function parseProviderStatuses(value: unknown): ConnectorOAuthProviderStatus[] | null {
  if (!Array.isArray(value)) return null;
  const statuses = value.map(parseProviderStatus);
  if (statuses.some((status) => status === null)) return null;
  return statuses as ConnectorOAuthProviderStatus[];
}

function readCachedProviderStatuses(): ConnectorOAuthProviderStatus[] {
  try {
    const raw = globalThis.localStorage?.getItem(STATUS_CACHE_STORAGE_KEY);
    if (!raw) return [];
    return parseProviderStatuses(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

function persistProviderStatuses(statuses: ConnectorOAuthProviderStatus[]): void {
  try {
    globalThis.localStorage?.setItem(STATUS_CACHE_STORAGE_KEY, JSON.stringify(statuses));
  } catch {
    // Storage can be unavailable in hardened browser contexts; the live refresh still works.
  }
}

function resolveProviderState(status: ConnectorOAuthProviderStatus): ProviderPresentationState {
  if (isCliAuthMode(status.authMode) && status.installState === 'failed') return 'install_error';
  if (status.stale) return 'unavailable';
  if (isCliAuthMode(status.authMode)) {
    if (status.id === 'tmeet' && status.step === 1) return 'connecting_single';
    if (status.step === 1) return 'connecting_step_1';
    if (status.step === 2) return 'connecting_step_2';
    if (status.blocked) return 'admin_blocked';
    return status.connected ? 'connected' : 'ready';
  }
  if (!status.clientIdConfigured) return 'missing_client_id';
  if (status.connected) {
    return status.requiresClientSecret && !status.clientSecretConfigured
      ? 'unavailable'
      : 'connected';
  }
  if (status.loopbackRedirectUriSupport !== 'confirmed') return 'unavailable';
  if (!status.requiresClientSecret) return 'ready';
  if (!status.clientSecretConfigured) return 'needs_secret';
  return 'ready';
}

function getProviderName(status: ConnectorOAuthProviderStatus, text: SaaSConnectorsText): string {
  if (status.id === 'feishu') return text.providers.feishu;
  if (status.id === 'google-calendar') return text.providers.googleCalendar;
  if (status.id === 'tmeet') return text.providers.tmeet;
  return status.displayName;
}

function getProviderCapability(status: ConnectorOAuthProviderStatus, text: SaaSConnectorsText): string {
  if (status.id === 'google-calendar') return text.capabilities.googleCalendar;
  if (status.id === 'tmeet') return text.capabilities.tmeet;
  return status.id === 'custom-oauth' ? text.capabilities.customOAuth : text.capabilities.feishu;
}

function getConnectedText(providerId: string, text: SaaSConnectorsText): string {
  if (providerId === 'custom-oauth') return text.toast.customConnected;
  return providerId === 'google-calendar' ? text.toast.googleCalendarConnected : text.toast.connected;
}

function getDisconnectedText(providerId: string, text: SaaSConnectorsText): string {
  if (providerId === 'custom-oauth') return text.toast.customDisconnected;
  if (providerId === 'google-calendar') return text.toast.googleCalendarDisconnected;
  return providerId === 'tmeet' ? text.toast.tmeetDisconnected : text.toast.disconnected;
}

function getTryItExamples(status: ConnectorOAuthProviderStatus, text: SaaSConnectorsText): string[] {
  if (status.id === 'google-calendar') return text.tryIt.googleCalendar;
  if (status.id === 'tmeet') return text.tryIt.tmeet;
  return status.id === 'custom-oauth' ? text.tryIt.customOAuth : text.tryIt.feishu;
}

function getCliConnectLabel(status: ConnectorOAuthProviderStatus, text: SaaSConnectorsText): string {
  return status.id === 'tmeet' ? text.actions.connectTmeet : text.actions.connectFeishu;
}

function getStatePresentation(
  state: ProviderPresentationState,
  status: ConnectorOAuthProviderStatus,
  text: SaaSConnectorsText,
): { badge: string; badgeClassName: string; detail: string; actionLabel: string } {
  switch (state) {
    case 'missing_client_id':
      return {
        badge: text.badges.unavailable,
        badgeClassName: 'border border-red-500/25 bg-red-500/15 text-badge-danger',
        detail: text.details.missingClientId,
        actionLabel: text.actions.none,
      };
    case 'needs_secret':
      return {
        badge: text.badges.needsSetup,
        badgeClassName: 'border border-badge-warning/25 bg-amber-500/15 text-badge-warning',
        detail: text.details.needsSecret,
        actionLabel: text.actions.saveAndConnect,
      };
    case 'connected':
      return {
        badge: text.badges.connected,
        badgeClassName: 'bg-emerald-500/10 text-badge-success',
        detail: status.authMode === 'lark-cli' && status.userName && status.tenantName
          ? text.details.connectedIdentity
            .replace('{user}', status.userName)
            .replace('{tenant}', status.tenantName)
          : '',
        actionLabel: text.actions.startUsing,
      };
    case 'connecting_step_1':
      return {
        badge: text.badges.connectingStep1,
        badgeClassName: 'border border-amber-500/25 bg-amber-500/15 text-badge-warning',
        detail: text.details.creatingApp,
        actionLabel: text.actions.cancel,
      };
    case 'connecting_step_2':
      return {
        badge: text.badges.connectingStep2,
        badgeClassName: 'border border-amber-500/25 bg-amber-500/15 text-badge-warning',
        detail: text.details.authorizing,
        actionLabel: text.actions.cancel,
      };
    case 'connecting_single':
      return {
        badge: text.badges.connectingSingle,
        badgeClassName: 'border border-amber-500/25 bg-amber-500/15 text-badge-warning',
        detail: text.details.tmeetAuthorizing,
        actionLabel: text.actions.cancel,
      };
    case 'admin_blocked':
      return {
        badge: text.badges.adminRequired,
        badgeClassName: 'border border-red-500/25 bg-red-500/15 text-badge-danger',
        detail: text.details.adminRequired,
        actionLabel: text.actions.retry,
      };
    case 'install_error':
      return getInstallErrorPresentation(text);
    case 'ready':
      return {
        badge: text.badges.notConnected,
        badgeClassName: 'border border-badge-info/25 bg-sky-500/15 text-badge-info',
        detail: isCliAuthMode(status.authMode)
          ? status.id === 'tmeet' ? text.details.tmeetCliReady : text.details.larkCliReady
          : status.requiresClientSecret ? text.details.ready : text.details.noSecretRequired,
        actionLabel: isCliAuthMode(status.authMode) ? getCliConnectLabel(status, text) : text.actions.connect,
      };
    default:
      return {
        badge: text.badges.unavailable,
        badgeClassName: 'bg-zinc-700 text-zinc-300',
        detail: text.details.statusUnavailable,
        actionLabel: text.actions.none,
      };
  }
}

export {
  CLI_LOGO_BY_PROVIDER,
  CONNECT_ACTION_BY_PROVIDER,
  getCliConnectLabel,
  getConnectedText,
  getDisconnectedText,
  getProviderCapability,
  getProviderName,
  getStatePresentation,
  getTryItExamples,
  isCliAuthMode,
  isRecord,
  parseProviderStatuses,
  persistProviderStatuses,
  readCachedProviderStatuses,
  resolveProviderState,
};
export type {
  ConnectorAuthMode,
  ConnectorOAuthProviderStatus,
};
