// ============================================================================
// SaaSConnectorsSection - SaaS OAuth cards in the unified connector grid
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Link2,
  Loader2,
  MessageCircle,
  Unplug,
  Video,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { CLI_CONNECTOR_DESCRIPTORS } from '@shared/constants/cliConnectorDescriptors';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { useConnectorInChat } from '../../../../hooks/useConnectorInChat';
import { Z_LAYERS } from '../../../../styles/zLayers';
import { Button, Input, Modal } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { ConnectorLogo } from '../../connectors/ConnectorLogo';

type LoopbackRedirectUriSupport = 'confirmed' | 'pending-verification' | 'unsupported';
type ConnectorAuthMode = 'oauth' | 'lark-cli' | 'tmeet-cli';

const CLI_LOGO_BY_PROVIDER = new Map(
  CLI_CONNECTOR_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.logo]),
);

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
  blocked?: boolean;
  stale?: boolean;
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
  | 'unavailable';

type SaaSConnectorsText = ReturnType<typeof useI18n>['t']['settings']['saasConnectors'];

const CONNECT_ACTION_BY_PROVIDER: Readonly<Record<string, string>> = {
  feishu: 'message.send-as-user',
  tmeet: 'meeting.create',
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
    blocked,
    stale,
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
    || (blocked !== undefined && typeof blocked !== 'boolean')
    || (stale !== undefined && typeof stale !== 'boolean')
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
    ...(typeof blocked === 'boolean' ? { blocked } : {}),
    ...(stale === true ? { stale: true } : {}),
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
  if (status.id === 'tmeet') return text.providers.tmeet;
  return status.displayName;
}

function getProviderCapability(status: ConnectorOAuthProviderStatus, text: SaaSConnectorsText): string {
  return status.id === 'tmeet' ? text.capabilities.tmeet : text.capabilities.feishu;
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

export interface SaaSConnectorsSectionProps {
  readonlyMcpConfigured?: boolean;
  onConfigureReadonlyMcp?: () => void;
}

export const SaaSConnectorsSection: React.FC<SaaSConnectorsSectionProps> = ({
  readonlyMcpConfigured = false,
  onConfigureReadonlyMcp,
}) => {
  const { t } = useI18n();
  const useInChat = useConnectorInChat();
  const text = t.settings.saasConnectors;
  const initialStatuses = useMemo(readCachedProviderStatuses, []);
  const [statuses, setStatuses] = useState<ConnectorOAuthProviderStatus[]>(initialStatuses);
  const statusesRef = useRef(initialStatuses);
  const [loading, setLoading] = useState(initialStatuses.length === 0);
  const [statusInvalid, setStatusInvalid] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ kind: 'info' | 'success'; text: string } | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customAppOpen, setCustomAppOpen] = useState(false);

  const refresh = useCallback(async (): Promise<ConnectorOAuthProviderStatus[] | null> => {
    try {
      const payload = await ipcService.invokeDomain<unknown>(
        IPC_DOMAINS.CONNECTOR,
        'oauthStatus',
      );
      const nextStatuses = parseProviderStatuses(payload);
      if (!nextStatuses) {
        setStatusInvalid(statusesRef.current.length === 0);
        setError(null);
        return null;
      }
      statusesRef.current = nextStatuses;
      setStatuses(nextStatuses);
      persistProviderStatuses(nextStatuses);
      setStatusInvalid(false);
      setError(null);
      return nextStatuses;
    } catch {
      setStatusInvalid(false);
      setError(text.errors.loadFailed);
      return null;
    } finally {
      setLoading(false);
    }
  }, [text.errors.loadFailed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!busyKey?.endsWith(':connect')) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 250);
    return () => window.clearInterval(timer);
  }, [busyKey, refresh]);

  useEffect(() => {
    if (receipt?.kind !== 'success') return;
    const timer = window.setTimeout(() => setReceipt(null), 3000);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  const presentationById = useMemo(() => new Map(statuses.map((status) => [
    status.id,
    resolveProviderState(status),
  ])), [statuses]);

  const connect = useCallback(async (
    providerId: string,
    authMode: ConnectorAuthMode = 'oauth',
  ) => {
    const action = CONNECT_ACTION_BY_PROVIDER[providerId];
    if (!action) {
      setError(text.errors.statusUnavailable);
      return;
    }

    setBusyKey(`${providerId}:connect`);
    setError(null);
    setReceipt({
      kind: 'info',
      text: providerId === 'tmeet' ? text.toast.tmeetAuthorizationOpened : text.toast.authorizationOpened,
    });
    if (isCliAuthMode(authMode)) {
      setStatuses((current) => current.map((status) => status.id === providerId
        ? { ...status, step: 1, blocked: false }
        : status));
    }
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthConnect',
        { providerId, action, authMode },
      );
      const nextStatuses = await refresh();
      const nextStatus = nextStatuses?.find((status) => status.id === providerId);
      if (!nextStatus || resolveProviderState(nextStatus) !== 'connected') {
        setReceipt(null);
        setError(text.errors.statusUnavailable);
        return;
      }
      setReceipt({
        kind: 'success',
        text: providerId === 'tmeet' ? text.toast.tmeetConnected : text.toast.connected,
      });
    } catch (caught) {
      setReceipt(null);
      if (isCliAuthMode(authMode)) await refresh();
      if (
        (isRecord(caught) && caught.code === 'CANCELLED')
        || (caught instanceof Error && /OAuth flow cancelled/i.test(caught.message))
      ) {
        setReceipt({
          kind: 'success',
          text: providerId === 'tmeet'
            ? text.toast.tmeetAuthorizationCancelled
            : text.toast.authorizationCancelled,
        });
      } else if (isRecord(caught) && caught.code === 'ADMIN_REQUIRED') {
        await refresh();
      } else {
        setError(text.errors.connectFailed);
      }
    } finally {
      setBusyKey(null);
    }
  }, [refresh, text]);

  const saveAndConnect = useCallback(async (
    providerId: string,
    authMode: ConnectorAuthMode = 'oauth',
    refreshBeforeConnect = true,
  ) => {
    const clientSecret = secretDrafts[providerId] ?? '';
    if (!clientSecret.trim()) return;

    setBusyKey(`${providerId}:save`);
    setError(null);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthSetSecret',
        { providerId, clientSecret, authMode },
      );
      setSecretDrafts((current) => ({ ...current, [providerId]: '' }));
      if (!refreshBeforeConnect) {
        await connect(providerId, authMode);
        return;
      }
      const nextStatuses = await refresh();
      const nextStatus = nextStatuses?.find((status) => status.id === providerId);
      if (!nextStatus || resolveProviderState(nextStatus) !== 'ready') {
        setError(text.errors.statusUnavailable);
        return;
      }
      await connect(providerId, authMode);
    } catch {
      setError(text.errors.saveFailed);
    } finally {
      setBusyKey(null);
    }
  }, [connect, refresh, secretDrafts, text.errors.saveFailed, text.errors.statusUnavailable]);

  const cancelConnect = useCallback(async (providerId: string) => {
    try {
      const payload = await ipcService.invokeDomain<unknown>(
        IPC_DOMAINS.CONNECTOR,
        'oauthCancelConnect',
        { providerId },
      );
      const nextStatuses = parseProviderStatuses(payload);
      if (nextStatuses) setStatuses(nextStatuses);
    } catch {
      setError(text.errors.disconnectFailed);
    }
  }, [text.errors.disconnectFailed]);

  const disconnect = useCallback(async (providerId: string) => {
    setPendingDisconnectId(null);
    setBusyKey(`${providerId}:disconnect`);
    setError(null);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthDisconnect',
        { providerId },
      );
      await refresh();
      setReceipt({
        kind: 'success',
        text: providerId === 'tmeet' ? text.toast.tmeetDisconnected : text.toast.disconnected,
      });
      setActiveProviderId(null);
      setCustomAppOpen(false);
    } catch {
      setError(text.errors.disconnectFailed);
    } finally {
      setBusyKey(null);
    }
  }, [refresh, text.errors.disconnectFailed, text.toast.disconnected]);

  const activeStatus = activeProviderId
    ? statuses.find((status) => status.id === activeProviderId)
    : undefined;
  const activeState = activeStatus ? resolveProviderState(activeStatus) : undefined;
  const pendingDisconnectStatus = pendingDisconnectId
    ? statuses.find((status) => status.id === pendingDisconnectId)
    : undefined;

  return (
    <div className="contents" data-testid="saas-connectors-section">
      {receipt && (
        <div
          role="status"
          data-testid="saas-connector-toast"
          className={`fixed right-6 top-6 flex max-w-sm items-center gap-2 rounded-lg border bg-zinc-900 px-3 py-2 text-xs shadow-2xl ${
            receipt.kind === 'success'
              ? 'border-emerald-500/30 text-badge-success'
              : 'border-amber-500/30 text-badge-warning'
          }`}
          style={{ zIndex: Z_LAYERS.toast }}
        >
          {receipt.kind === 'success' ? null : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {receipt.text}
        </div>
      )}

      {loading && statuses.length === 0 ? (
        ['feishu', 'tmeet'].map((providerId) => (
          <div
            key={providerId}
            className="min-h-36 animate-pulse rounded-xl border border-zinc-700 bg-zinc-900/60 p-4"
            data-testid={`saas-connector-skeleton-${providerId}`}
            aria-label={text.loading}
          >
            <div className="flex items-center gap-2.5">
              <span className="h-9 w-9 rounded-lg bg-zinc-800" />
              <span className="h-4 w-24 rounded bg-zinc-800" />
            </div>
            <div className="mt-4 h-3 w-full rounded bg-zinc-800" />
            <div className="mt-2 h-3 w-2/3 rounded bg-zinc-800" />
          </div>
        ))
      ) : statusInvalid || statuses.length === 0 ? (
        <div className="min-h-36 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-4 text-xs text-zinc-400">
          {statusInvalid ? text.errors.statusUnavailable : text.empty}
        </div>
      ) : statuses.map((status) => {
        const state = presentationById.get(status.id) ?? 'unavailable';
        const presentation = getStatePresentation(state, status, text);
        const providerName = getProviderName(status, text);
        const isLarkCli = status.authMode === 'lark-cli';
        const isCli = isCliAuthMode(status.authMode);
        const isProgress = state === 'connecting_step_1'
          || state === 'connecting_step_2'
          || state === 'connecting_single';
        const rowBusy = Boolean(busyKey?.startsWith(`${status.id}:`));
        const showConnecting = isProgress || (!isCli && busyKey === `${status.id}:connect`);
        const isUnavailable = state === 'missing_client_id' || state === 'unavailable';
        const secretDraft = secretDrafts[status.id] ?? '';

        return (
          <div
            key={status.id}
            role="button"
            tabIndex={0}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('button, input')) return;
              setActiveProviderId(status.id);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') setActiveProviderId(status.id);
            }}
            className={`group min-h-36 cursor-pointer rounded-xl border bg-zinc-900/60 p-4 text-left transition-colors hover:border-zinc-600 ${
              showConnecting
                ? 'border-amber-500/40'
                : state === 'admin_blocked'
                  ? 'border-red-500/30'
                  : isUnavailable ? 'border-dashed border-zinc-700 opacity-70' : 'border-zinc-700'
            }`}
            data-testid={`saas-connector-${status.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
                  <ConnectorLogo
                    id={CLI_LOGO_BY_PROVIDER.get(status.id)}
                    displayName={providerName}
                    fallback={status.id === 'tmeet'
                      ? <Video className="h-4 w-4 text-badge-info" />
                      : <CalendarDays className="h-4 w-4 text-badge-info" />}
                  />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {(state === 'connected' || showConnecting || state === 'admin_blocked' || isUnavailable) && (
                      <span
                        data-testid={`saas-status-dot-${status.id}`}
                        className={`h-2 w-2 rounded-full ${
                          showConnecting
                            ? 'animate-pulse bg-amber-400'
                            : state === 'connected'
                              ? 'bg-mark-success'
                              : state === 'admin_blocked' ? 'bg-red-400' : 'bg-zinc-600'
                        }`}
                      />
                    )}
                    <span className="truncate text-sm font-medium text-zinc-100">{providerName}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                      showConnecting && !isCli
                        ? 'border border-amber-500/25 bg-amber-500/15 text-badge-warning'
                        : presentation.badgeClassName
                    }`}>
                      {showConnecting && !isCli ? text.badges.connecting : presentation.badge}
                    </span>
                  </div>
                </div>
              </div>
              {state === 'connected' ? (
                <button /* ds-allow:button: 卡片右上角紧凑断开动作位 */
                  type="button"
                  aria-label={`${text.actions.disconnect} ${providerName}`}
                  title={`${text.actions.disconnect} ${providerName}`}
                  data-testid={`saas-card-action-${status.id}`}
                  disabled={rowBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingDisconnectId(status.id);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-600 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-wait"
                >
                  {rowBusy
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-badge-warning" />
                    : <Unplug className="h-3.5 w-3.5" />}
                </button>
              ) : !isCli && !isUnavailable && (
                <button /* ds-allow:button: 卡片右上角紧凑状态动作位 */
                  type="button"
                  aria-label={`${rowBusy ? text.actions.connecting : presentation.actionLabel} ${providerName}`}
                  data-testid={`saas-card-action-${status.id}`}
                  disabled={rowBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveProviderId(status.id);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-600 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-wait"
                >
                  {rowBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-badge-warning" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
            <p className={`mt-3 text-xs leading-relaxed ${
              state === 'admin_blocked'
                ? 'text-badge-danger'
                : showConnecting ? 'text-badge-warning' : 'text-zinc-400'
            }`}>
              {showConnecting && <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />}
              {presentation.detail || getProviderCapability(status, text)}
            </p>

            {state === 'connected' && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void useInChat({ kind: 'connector', id: status.id })}
                data-testid={`saas-use-in-chat-${status.id}`}
                className="mt-3"
              >
                {text.actions.startUsing}
              </Button>
            )}

            {isCli && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {state === 'ready' && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={rowBusy}
                      onClick={() => void connect(status.id, status.authMode)}
                      leftIcon={<Link2 className="h-3 w-3" />}
                      data-testid={`saas-connect-${status.id}`}
                    >
                      {getCliConnectLabel(status, text)}
                    </Button>
                  )}
                  {isProgress && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void cancelConnect(status.id)}
                      data-testid={`saas-cancel-${status.id}`}
                    >
                      {text.actions.cancel}
                    </Button>
                  )}
                  {state === 'admin_blocked' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={rowBusy}
                      onClick={() => void connect(status.id, 'lark-cli')}
                      data-testid={`saas-retry-${status.id}`}
                    >
                      {text.actions.retry}
                    </Button>
                  )}
                </div>

                {isLarkCli && (state === 'ready' || state === 'admin_blocked') && (
                  <div className="pt-1">
                    <button /* ds-allow:button: 飞书卡片内普通用户可见的自建应用折叠项 */
                      type="button"
                      className="flex items-center gap-1 text-[11px] text-badge-info hover:opacity-80"
                      aria-expanded={customAppOpen}
                      onClick={() => setCustomAppOpen((current) => !current)}
                      data-testid={`saas-custom-app-toggle-${status.id}`}
                    >
                      {customAppOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {text.customApp.title}
                    </button>
                    {customAppOpen && (
                      <div className="mt-2 rounded-md border border-zinc-700/60 bg-zinc-950/40 p-3" data-testid={`saas-custom-app-${status.id}`}>
                        <label className="mb-1 block text-[11px] font-medium text-zinc-400" htmlFor={`saas-custom-secret-${status.id}`}>
                          {text.secret.label}
                        </label>
                        <Input
                          id={`saas-custom-secret-${status.id}`}
                          type="password"
                          autoComplete="new-password"
                          inputSize="sm"
                          value={secretDraft}
                          disabled={rowBusy}
                          onChange={(event) => setSecretDrafts((current) => ({
                            ...current,
                            [status.id]: event.target.value,
                          }))}
                          placeholder={text.secret.placeholder}
                          aria-label={`${providerName} ${text.secret.label}`}
                          data-testid={`saas-custom-secret-input-${status.id}`}
                          className="bg-zinc-950 px-2"
                        />
                        <div className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{text.secret.customAppHint}</div>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={busyKey === `${status.id}:save`}
                          disabled={rowBusy || !secretDraft.trim()}
                          onClick={() => void saveAndConnect(status.id, 'oauth', false)}
                          data-testid={`saas-custom-save-connect-${status.id}`}
                          className="mt-3"
                        >
                          {text.actions.saveAndConnect}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isCli && (
              <div className={`mt-3 text-[11px] ${rowBusy ? 'text-badge-warning' : 'text-zinc-500'}`}>
                {rowBusy ? text.badges.connecting : presentation.badge}
                {status.requiresClientSecret && status.clientSecretConfigured
                  ? `${text.metaSeparator}${text.clientSecretSaved}`
                  : ''}
              </div>
            )}
          </div>
        );
      })}

      <Modal
        isOpen={Boolean(activeStatus)}
        onClose={() => setActiveProviderId(null)}
        title={activeStatus ? getProviderName(activeStatus, text) : text.title}
        size="md"
        portal
      >
        {activeStatus && activeState && (() => {
          const providerName = getProviderName(activeStatus, text);
          const presentation = getStatePresentation(activeState, activeStatus, text);
          const rowBusy = Boolean(busyKey?.startsWith(`${activeStatus.id}:`));
          const isSaving = busyKey === `${activeStatus.id}:save`;
          const isConnecting = busyKey === `${activeStatus.id}:connect`;
          const isCli = isCliAuthMode(activeStatus.authMode);
          const canConnect = Boolean(CONNECT_ACTION_BY_PROVIDER[activeStatus.id]);
          const secretDraft = secretDrafts[activeStatus.id] ?? '';

          return (
            <div className="space-y-4 p-5" data-testid={`saas-detail-${activeStatus.id}`}>
              <div className="text-center">
                <div className="mx-auto flex w-fit items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
                    <MessageCircle className="h-4 w-4 text-zinc-300" />
                  </span>
                  <span className="text-zinc-600">⇋</span>
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
                    <ConnectorLogo
                      id={CLI_LOGO_BY_PROVIDER.get(activeStatus.id)}
                      displayName={providerName}
                      fallback={activeStatus.id === 'tmeet'
                        ? <Video className="h-4 w-4 text-badge-info" />
                        : <CalendarDays className="h-4 w-4 text-badge-info" />}
                    />
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <span className="font-medium text-zinc-100">{providerName}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${presentation.badgeClassName}`}>
                    {isConnecting && !isCli ? text.badges.connecting : presentation.badge}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  {getProviderCapability(activeStatus, text)}
                </p>
              </div>

              {presentation.detail && (
                <div className={`rounded-md border px-3 py-2 text-xs ${
                  activeState === 'missing_client_id' || activeState === 'admin_blocked'
                    ? 'border-red-500/25 bg-red-500/10 text-badge-danger'
                    : activeState === 'connecting_step_1'
                        || activeState === 'connecting_step_2'
                        || activeState === 'connecting_single'
                      ? 'border-amber-500/25 bg-amber-500/10 text-badge-warning'
                    : 'border-zinc-700 bg-zinc-950/40 text-zinc-400'
                }`}>
                  {presentation.detail}
                </div>
              )}

              {activeState === 'needs_secret' && (
                <div className="rounded-md border border-zinc-700/60 bg-zinc-950/40 p-3">
                  <label className="mb-1 block text-[11px] font-medium text-zinc-400" htmlFor={`saas-secret-${activeStatus.id}`}>
                    {text.secret.label}
                  </label>
                  <Input
                    id={`saas-secret-${activeStatus.id}`}
                    type="password"
                    autoComplete="new-password"
                    inputSize="sm"
                    value={secretDraft}
                    disabled={rowBusy}
                    onChange={(event) => setSecretDrafts((current) => ({
                      ...current,
                      [activeStatus.id]: event.target.value,
                    }))}
                    placeholder={text.secret.placeholder}
                    aria-label={`${providerName} ${text.secret.label}`}
                    data-testid={`saas-secret-input-${activeStatus.id}`}
                    className="bg-zinc-950 px-2"
                  />
                  <div className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{text.secret.hint}</div>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={isSaving}
                    disabled={rowBusy || !secretDraft.trim() || !canConnect}
                    onClick={() => void saveAndConnect(activeStatus.id)}
                    data-testid={`saas-save-connect-${activeStatus.id}`}
                    className="mt-3"
                  >
                    {isSaving ? text.actions.saving : text.actions.saveAndConnect}
                  </Button>
                </div>
              )}

              {activeState === 'ready' && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={isConnecting}
                  disabled={rowBusy || !canConnect}
                  onClick={() => void connect(activeStatus.id, activeStatus.authMode)}
                  leftIcon={!isConnecting ? <Link2 className="h-3 w-3" /> : undefined}
                  data-testid={`saas-connect-${activeStatus.id}`}
                >
                  {isConnecting
                    ? text.actions.connecting
                    : isCli ? getCliConnectLabel(activeStatus, text) : text.actions.connect}
                </Button>
              )}

              {(activeState === 'connecting_step_1'
                || activeState === 'connecting_step_2'
                || activeState === 'connecting_single') && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void cancelConnect(activeStatus.id)}
                  data-testid={`saas-cancel-${activeStatus.id}`}
                >
                  {text.actions.cancel}
                </Button>
              )}

              {activeState === 'admin_blocked' && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={rowBusy}
                  onClick={() => void connect(activeStatus.id, 'lark-cli')}
                  data-testid={`saas-retry-${activeStatus.id}`}
                >
                  {text.actions.retry}
                </Button>
              )}

              {activeState === 'connected' && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-md border border-badge-warning/20 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-badge-warning">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {isCli
                        ? activeStatus.id === 'tmeet'
                          ? text.disconnect.tmeetCliNotice
                          : text.disconnect.larkCliNotice
                        : activeStatus.requiresClientSecret
                          ? text.disconnect.noticeWithSecret
                          : text.disconnect.noticeWithoutSecret}
                    </span>
                  </div>
                </div>
              )}

              <div className="border-t border-zinc-700 pt-3">
                <div className="text-[11px] font-medium text-zinc-400">{text.tryIt.title}</div>
                <ul className="mt-2 space-y-2 text-xs leading-relaxed text-zinc-300">
                  {(activeStatus.id === 'tmeet' ? text.tryIt.tmeet : text.tryIt.feishu)
                    .map((example) => <li key={example}>{example}</li>)}
                </ul>
              </div>

              {activeStatus.id === 'feishu' && (
                <div className="border-t border-zinc-700 pt-3">
                  <button /* ds-allow:button: 详情弹层内进阶区展开触发器 */
                    type="button"
                    className="flex w-full items-center justify-between text-left text-xs font-medium text-zinc-300"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((current) => !current)}
                  >
                    {text.advanced.title}
                    {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  {advancedOpen && (
                    <div className="mt-2 rounded-md border border-dashed border-zinc-700 bg-zinc-950/40 p-3">
                      <div className="text-xs font-medium text-zinc-300">{text.advanced.readonlyTitle}</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{text.advanced.readonlyDescription}</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={readonlyMcpConfigured || !onConfigureReadonlyMcp}
                        onClick={() => {
                          setActiveProviderId(null);
                          onConfigureReadonlyMcp?.();
                        }}
                        className="mt-3"
                      >
                        {readonlyMcpConfigured ? text.advanced.configured : text.advanced.configure}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {error && <div className="text-xs text-badge-danger">{error}</div>}
            </div>
          );
        })()}
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(pendingDisconnectStatus)}
        title={text.disconnect.confirmTitle}
        message={pendingDisconnectStatus && isCliAuthMode(pendingDisconnectStatus.authMode)
          ? pendingDisconnectStatus.id === 'tmeet'
            ? text.disconnect.tmeetCliConfirmMessage
            : text.disconnect.larkCliConfirmMessage
          : text.disconnect.confirmMessage}
        variant="danger"
        confirmText={text.actions.disconnect}
        cancelText={t.common.cancel}
        confirmDisabled={Boolean(busyKey)}
        onConfirm={() => pendingDisconnectStatus && void disconnect(pendingDisconnectStatus.id)}
        onCancel={() => setPendingDisconnectId(null)}
      />
    </div>
  );
};
