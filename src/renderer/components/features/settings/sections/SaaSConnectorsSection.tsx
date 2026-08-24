// ============================================================================
// SaaSConnectorsSection - SaaS OAuth cards in the unified connector grid
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Link2,
  Loader2,
  MessageCircle,
  Unplug,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Z_LAYERS } from '../../../../styles/zLayers';
import { Button, Input, Modal } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';

type LoopbackRedirectUriSupport = 'confirmed' | 'pending-verification' | 'unsupported';

interface ConnectorOAuthProviderStatus {
  id: string;
  displayName: string;
  clientIdConfigured: boolean;
  requiresClientSecret: boolean;
  clientSecretConfigured: boolean;
  connected: boolean;
  loopbackRedirectUriSupport: LoopbackRedirectUriSupport;
}

type ProviderPresentationState =
  | 'missing_client_id'
  | 'needs_secret'
  | 'ready'
  | 'connected'
  | 'unavailable';

type SaaSConnectorsText = ReturnType<typeof useI18n>['t']['settings']['saasConnectors'];

const CONNECT_ACTION_BY_PROVIDER: Readonly<Record<string, string>> = {
  feishu: 'message.send-as-user',
};

const LOOPBACK_SUPPORT_VALUES = new Set<LoopbackRedirectUriSupport>([
  'confirmed',
  'pending-verification',
  'unsupported',
]);

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
  };
}

function parseProviderStatuses(value: unknown): ConnectorOAuthProviderStatus[] | null {
  if (!Array.isArray(value)) return null;
  const statuses = value.map(parseProviderStatus);
  if (statuses.some((status) => status === null)) return null;
  return statuses as ConnectorOAuthProviderStatus[];
}

function resolveProviderState(status: ConnectorOAuthProviderStatus): ProviderPresentationState {
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
  return status.id === 'feishu' ? text.providers.feishu : status.displayName;
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
        detail: '',
        actionLabel: text.actions.startUsing,
      };
    case 'ready':
      return {
        badge: text.badges.notConnected,
        badgeClassName: 'border border-badge-info/25 bg-sky-500/15 text-badge-info',
        detail: status.requiresClientSecret ? text.details.ready : text.details.noSecretRequired,
        actionLabel: text.actions.connect,
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
  const text = t.settings.saasConnectors;
  const [statuses, setStatuses] = useState<ConnectorOAuthProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusInvalid, setStatusInvalid] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ kind: 'info' | 'success'; text: string } | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const refresh = useCallback(async (): Promise<ConnectorOAuthProviderStatus[] | null> => {
    try {
      const payload = await ipcService.invokeDomain<unknown>(
        IPC_DOMAINS.CONNECTOR,
        'oauthStatus',
      );
      const nextStatuses = parseProviderStatuses(payload);
      if (!nextStatuses) {
        setStatuses([]);
        setStatusInvalid(true);
        setError(null);
        return null;
      }
      setStatuses(nextStatuses);
      setStatusInvalid(false);
      setError(null);
      return nextStatuses;
    } catch {
      setStatuses([]);
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
    if (receipt?.kind !== 'success') return;
    const timer = window.setTimeout(() => setReceipt(null), 3000);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  const presentationById = useMemo(() => new Map(statuses.map((status) => [
    status.id,
    resolveProviderState(status),
  ])), [statuses]);

  const connect = useCallback(async (providerId: string) => {
    const action = CONNECT_ACTION_BY_PROVIDER[providerId];
    if (!action) {
      setError(text.errors.statusUnavailable);
      return;
    }

    setBusyKey(`${providerId}:connect`);
    setError(null);
    setReceipt({ kind: 'info', text: text.toast.authorizationOpened });
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthConnect',
        { providerId, action },
      );
      const nextStatuses = await refresh();
      const nextStatus = nextStatuses?.find((status) => status.id === providerId);
      if (!nextStatus || resolveProviderState(nextStatus) !== 'connected') {
        setReceipt(null);
        setError(text.errors.statusUnavailable);
        return;
      }
      setReceipt({ kind: 'success', text: text.toast.connected });
    } catch (caught) {
      setReceipt(null);
      if (
        (isRecord(caught) && caught.code === 'CANCELLED')
        || (caught instanceof Error && /OAuth flow cancelled/i.test(caught.message))
      ) {
        setReceipt({ kind: 'success', text: text.toast.authorizationCancelled });
      } else {
        setError(text.errors.connectFailed);
      }
    } finally {
      setBusyKey(null);
    }
  }, [refresh, text]);

  const saveAndConnect = useCallback(async (providerId: string) => {
    const clientSecret = secretDrafts[providerId] ?? '';
    if (!clientSecret.trim()) return;

    setBusyKey(`${providerId}:save`);
    setError(null);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthSetSecret',
        { providerId, clientSecret },
      );
      setSecretDrafts((current) => ({ ...current, [providerId]: '' }));
      const nextStatuses = await refresh();
      const nextStatus = nextStatuses?.find((status) => status.id === providerId);
      if (!nextStatus || resolveProviderState(nextStatus) !== 'ready') {
        setError(text.errors.statusUnavailable);
        return;
      }
      await connect(providerId);
    } catch {
      setError(text.errors.saveFailed);
    } finally {
      setBusyKey(null);
    }
  }, [connect, refresh, secretDrafts, text.errors.saveFailed, text.errors.statusUnavailable]);

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
      setReceipt({ kind: 'success', text: text.toast.disconnected });
      setActiveProviderId(null);
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

      {loading ? (
        <div className="flex min-h-36 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900/60">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-500" aria-label={text.loading} />
        </div>
      ) : statusInvalid || statuses.length === 0 ? (
        <div className="min-h-36 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-4 text-xs text-zinc-400">
          {statusInvalid ? text.errors.statusUnavailable : text.empty}
        </div>
      ) : statuses.map((status) => {
        const state = presentationById.get(status.id) ?? 'unavailable';
        const presentation = getStatePresentation(state, status, text);
        const providerName = getProviderName(status, text);
        const isConnecting = busyKey === `${status.id}:connect`;
        const isUnavailable = state === 'missing_client_id' || state === 'unavailable';

        return (
          <div
            key={status.id}
            role="button"
            tabIndex={0}
            onClick={() => setActiveProviderId(status.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setActiveProviderId(status.id);
            }}
            className={`group min-h-36 cursor-pointer rounded-xl border bg-zinc-900/60 p-4 text-left transition-colors hover:border-zinc-600 ${
              isConnecting ? 'border-amber-500/40' : isUnavailable ? 'border-dashed border-zinc-700 opacity-70' : 'border-zinc-700'
            }`}
            data-testid={`saas-connector-${status.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800">
                  <CalendarDays className="h-4 w-4 text-badge-info" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {(state === 'connected' || isConnecting || isUnavailable) && (
                      <span
                        data-testid={`saas-status-dot-${status.id}`}
                        className={`h-2 w-2 rounded-full ${
                          isConnecting
                            ? 'animate-pulse bg-amber-400'
                            : state === 'connected'
                              ? 'bg-mark-success'
                              : 'bg-zinc-600'
                        }`}
                      />
                    )}
                    <span className="truncate text-sm font-medium text-zinc-100">{providerName}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                      isConnecting
                        ? 'border border-amber-500/25 bg-amber-500/15 text-badge-warning'
                        : presentation.badgeClassName
                    }`}>
                      {isConnecting ? text.badges.connecting : presentation.badge}
                    </span>
                  </div>
                </div>
              </div>
              {!isUnavailable && (
                <button /* ds-allow:button: 卡片右上角紧凑状态动作位 */
                  type="button"
                  aria-label={`${isConnecting ? text.actions.connecting : presentation.actionLabel} ${providerName}`}
                  data-testid={`saas-card-action-${status.id}`}
                  disabled={isConnecting}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveProviderId(status.id);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-600 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-wait"
                >
                  {isConnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-badge-warning" />
                  ) : state === 'connected' ? (
                    <MessageCircle className="h-3.5 w-3.5 text-badge-info" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
            <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-zinc-400">
              {text.capabilities.feishu}
            </p>
            <div className={`mt-3 text-[11px] ${isConnecting ? 'text-badge-warning' : 'text-zinc-500'}`}>
              {isConnecting ? text.badges.connecting : presentation.badge}
              {status.requiresClientSecret && status.clientSecretConfigured
                ? `${text.metaSeparator}${text.clientSecretSaved}`
                : ''}
            </div>
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
          const isDisconnecting = busyKey === `${activeStatus.id}:disconnect`;
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
                    <CalendarDays className="h-4 w-4 text-badge-info" />
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <span className="font-medium text-zinc-100">{providerName}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${presentation.badgeClassName}`}>
                    {isConnecting ? text.badges.connecting : presentation.badge}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">{text.capabilities.feishu}</p>
              </div>

              {presentation.detail && (
                <div className={`rounded-md border px-3 py-2 text-xs ${
                  activeState === 'missing_client_id'
                    ? 'border-red-500/25 bg-red-500/10 text-badge-danger'
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
                  onClick={() => void connect(activeStatus.id)}
                  leftIcon={!isConnecting ? <Link2 className="h-3 w-3" /> : undefined}
                  data-testid={`saas-connect-${activeStatus.id}`}
                >
                  {isConnecting ? text.actions.connecting : text.actions.connect}
                </Button>
              )}

              {activeState === 'connected' && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-md border border-badge-warning/20 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-badge-warning">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {activeStatus.requiresClientSecret
                        ? text.disconnect.noticeWithSecret
                        : text.disconnect.noticeWithoutSecret}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={isDisconnecting}
                    disabled={rowBusy}
                    onClick={() => setPendingDisconnectId(activeStatus.id)}
                    leftIcon={<Unplug className="h-3 w-3" />}
                    data-testid={`saas-disconnect-${activeStatus.id}`}
                    className="border border-red-500/25 bg-transparent text-badge-danger hover:bg-red-500/10"
                  >
                    {isDisconnecting ? text.actions.disconnecting : text.actions.disconnect}
                  </Button>
                </div>
              )}

              <div className="border-t border-zinc-700 pt-3">
                <div className="text-[11px] font-medium text-zinc-400">{text.tryIt.title}</div>
                <ul className="mt-2 space-y-2 text-xs leading-relaxed text-zinc-300">
                  {text.tryIt.feishu.map((example) => <li key={example}>{example}</li>)}
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
        message={text.disconnect.confirmMessage}
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
