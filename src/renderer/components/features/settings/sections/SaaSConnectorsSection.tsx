// ============================================================================
// SaaSConnectorsSection - SaaS OAuth connector account management
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, Link2, Unplug } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Button, Input } from '../../../primitives';
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
        actionLabel: text.actions.disconnect,
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

export const SaaSConnectorsSection: React.FC = () => {
  const { t } = useI18n();
  const text = t.settings.saasConnectors;
  const [statuses, setStatuses] = useState<ConnectorOAuthProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusInvalid, setStatusInvalid] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null);

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
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthConnect',
        { providerId, action },
      );
      await refresh();
    } catch {
      setError(text.errors.connectFailed);
    } finally {
      setBusyKey(null);
    }
  }, [refresh, text.errors.connectFailed, text.errors.statusUnavailable]);

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
    } catch {
      setError(text.errors.disconnectFailed);
    } finally {
      setBusyKey(null);
    }
  }, [refresh, text.errors.disconnectFailed]);

  const pendingDisconnectStatus = pendingDisconnectId
    ? statuses.find((status) => status.id === pendingDisconnectId)
    : undefined;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-4" data-testid="saas-connectors-section">
      <div className="mb-3 flex items-center gap-2">
        <Cloud className="h-4 w-4 text-badge-info" />
        <h4 className="text-sm font-medium text-zinc-200">{text.title}</h4>
        <span className="rounded bg-zinc-600 px-1.5 py-0.5 text-xs text-zinc-400">{text.kind}</span>
      </div>
      <p className="mb-3 text-xs text-zinc-400">{text.description}</p>

      {loading ? (
        <div className="text-xs text-zinc-500">{text.loading}</div>
      ) : statusInvalid || statuses.length === 0 ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
          {statusInvalid ? text.errors.statusUnavailable : text.empty}
        </div>
      ) : (
        <div className="space-y-2">
          {statuses.map((status) => {
            const state = presentationById.get(status.id) ?? 'unavailable';
            const presentation = getStatePresentation(state, status, text);
            const providerName = getProviderName(status, text);
            const rowBusy = Boolean(busyKey?.startsWith(`${status.id}:`));
            const isSaving = busyKey === `${status.id}:save`;
            const isConnecting = busyKey === `${status.id}:connect`;
            const isDisconnecting = busyKey === `${status.id}:disconnect`;
            const canConnect = Boolean(CONNECT_ACTION_BY_PROVIDER[status.id]);
            const secretDraft = secretDrafts[status.id] ?? '';

            return (
              <div
                key={status.id}
                className="rounded-md border border-zinc-700 bg-zinc-900/40 px-3 py-2 transition-colors hover:border-zinc-600"
                data-testid={`saas-connector-${status.id}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-zinc-200">{providerName}</span>
                    <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-[11px] text-zinc-400">
                      {text.kind}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${presentation.badgeClassName}`}>
                      {presentation.badge}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {text.idPrefix}{status.id}
                    {status.requiresClientSecret && status.clientSecretConfigured
                      ? `${text.metaSeparator}${text.clientSecretSaved}`
                      : ''}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {text.availableActionsPrefix}{presentation.actionLabel}
                  </div>
                  {presentation.detail && (
                    <div className={`mt-1 text-xs ${state === 'missing_client_id' ? 'text-badge-danger' : 'text-zinc-400'}`}>
                      {presentation.detail}
                    </div>
                  )}
                </div>

                {state === 'needs_secret' && (
                  <div className="mt-3 rounded-md border border-zinc-700/60 bg-zinc-900/40 p-3">
                    <label className="mb-1 block text-[11px] font-medium text-zinc-500" htmlFor={`saas-secret-${status.id}`}>
                      {text.secret.label}
                    </label>
                    <Input
                      id={`saas-secret-${status.id}`}
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
                      data-testid={`saas-secret-input-${status.id}`}
                      className="max-w-sm bg-zinc-950 px-2"
                    />
                    <div className="mt-1.5 text-[11px] text-zinc-500">{text.secret.hint}</div>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={isSaving}
                        disabled={rowBusy || !secretDraft.trim() || !canConnect}
                        onClick={() => void saveAndConnect(status.id)}
                        data-testid={`saas-save-connect-${status.id}`}
                        className="rounded px-2 py-1 text-[11px]"
                      >
                        {isSaving ? text.actions.saving : text.actions.saveAndConnect}
                      </Button>
                    </div>
                  </div>
                )}

                {state === 'connected' && (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-badge-warning/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-badge-warning">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {status.requiresClientSecret
                        ? text.disconnect.noticeWithSecret
                        : text.disconnect.noticeWithoutSecret}
                    </span>
                  </div>
                )}

                {(state === 'ready' || state === 'connected') && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {state === 'ready' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={isConnecting}
                        disabled={rowBusy || !canConnect}
                        onClick={() => void connect(status.id)}
                        leftIcon={<Link2 className="h-3 w-3" />}
                        data-testid={`saas-connect-${status.id}`}
                        className="rounded px-2 py-1 text-[11px]"
                      >
                        {isConnecting ? text.actions.connecting : text.actions.connect}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={isDisconnecting}
                        disabled={rowBusy}
                        onClick={() => setPendingDisconnectId(status.id)}
                        leftIcon={<Unplug className="h-3 w-3" />}
                        data-testid={`saas-disconnect-${status.id}`}
                        className="rounded border border-red-500/25 bg-transparent px-2 py-1 text-[11px] text-badge-danger hover:bg-red-500/10"
                      >
                        {isDisconnecting ? text.actions.disconnecting : text.actions.disconnect}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="mt-3 text-xs text-badge-danger">{error}</div>}

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
