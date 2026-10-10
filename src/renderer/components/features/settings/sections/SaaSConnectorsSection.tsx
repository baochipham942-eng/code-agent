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
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { useConnectorInChat } from '../../../../hooks/useConnectorInChat';
import { Button, Input, Modal } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { ConnectorLogo } from '../../connectors/ConnectorLogo';
import { CustomOAuthConnectorForm, type CustomOAuthDescriptorDraft } from './CustomOAuthConnectorForm';
import { SaaSConnectorCardFooter } from './SaaSConnectorCardFooter';
import { SaaSConnectorFeedback } from './SaaSConnectorFeedback';
import {
  isInstallRepairState,
  saasConnectorDetailToneClass,
  SaaSConnectorInstallAction,
} from './SaaSConnectorInstallError';
import {
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
  type ConnectorAuthMode,
  type ConnectorOAuthProviderStatus,
} from './SaaSConnectorsModel';

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
  const connectingProvidersRef = useRef(new Set<string>());
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
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customDescriptorDraft, setCustomDescriptorDraft] = useState<CustomOAuthDescriptorDraft>({
    authorizeUrl: '',
    tokenUrl: '',
    clientId: '',
    requiresClientSecret: false,
    loopbackRedirectUriSupport: 'confirmed',
  });

  const refresh = useCallback(async (
    clearError = true,
  ): Promise<ConnectorOAuthProviderStatus[] | null> => {
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
      if (clearError) setError(null);
      return nextStatuses;
    } catch {
      setStatusInvalid(false);
      if (clearError) setError(text.errors.loadFailed);
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
      void refresh(false).then((nextStatuses) => {
        const tmeetStatus = nextStatuses?.find((status) => status.id === 'tmeet');
        if (busyKey === 'tmeet:connect' && tmeetStatus?.authorizationOpened) {
          setReceipt({ kind: 'info', text: text.toast.tmeetAuthorizationOpened });
        }
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [busyKey, refresh, text.toast.tmeetAuthorizationOpened]);

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
    if (connectingProvidersRef.current.has(providerId)) return;
    connectingProvidersRef.current.add(providerId);

    setBusyKey(`${providerId}:connect`);
    setError(null);
    setActiveProviderId(null);
    // The shared consent modal is now the pre-browser receipt. Do not claim the browser opened
    // while that decision is still pending; tmeet publishes a real authorizationOpened status.
    setReceipt(null);
    if (isCliAuthMode(authMode)) {
      setStatuses((current) => current.map((status) => status.id === providerId
        ? { ...status, step: 1, blocked: false }
        : status));
    }
    try {
      const connectResult = await ipcService.invokeDomain<unknown>(
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
        text: providerId === 'tmeet'
          ? isRecord(connectResult) && connectResult.alreadyConnected === true
            ? text.toast.tmeetAlreadyConnected
            : text.toast.tmeetConnected
          : getConnectedText(providerId, text),
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
      } else if (isRecord(caught) && caught.code === 'TIMEOUT') {
        setError(text.errors.authorizationTimedOut);
      } else if (isRecord(caught) && caught.code === 'ADMIN_REQUIRED') {
        await refresh();
      } else {
        const reason = caught instanceof Error && caught.message.trim()
          ? caught.message
          : text.errors.connectFailed;
        setError(providerId === 'tmeet'
          ? text.errors.tmeetAuthorizationOpenFailed.replace('{reason}', reason)
          : text.errors.connectFailedWithReason.replace('{reason}', reason));
      }
    } finally {
      connectingProvidersRef.current.delete(providerId);
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
        text: getDisconnectedText(providerId, text),
      });
      setActiveProviderId(null);
      setCustomAppOpen(false);
    } catch {
      setError(text.errors.disconnectFailed);
    } finally {
      setBusyKey(null);
    }
  }, [refresh, text.errors.disconnectFailed, text.toast.disconnected]);

  const saveCustomDescriptor = useCallback(async () => {
    setBusyKey('custom-oauth:descriptor');
    setError(null);
    try {
      await ipcService.invokeDomain(
        IPC_DOMAINS.CONNECTOR,
        'oauthSaveDescriptor',
        customDescriptorDraft,
      );
      const nextStatuses = await refresh();
      if (!nextStatuses?.some((status) => status.id === 'custom-oauth')) {
        setError(text.errors.statusUnavailable);
        return;
      }
      setCustomFormOpen(false);
      setActiveProviderId('custom-oauth');
      setReceipt({ kind: 'success', text: text.customOAuth.saved });
    } catch (caught) {
      const reason = caught instanceof Error && caught.message.trim()
        ? caught.message
        : text.errors.customDescriptorSaveFailed;
      setError(reason);
    } finally {
      setBusyKey(null);
    }
  }, [customDescriptorDraft, refresh, text.customOAuth.saved, text.errors.customDescriptorSaveFailed, text.errors.statusUnavailable]);

  const activeStatus = activeProviderId
    ? statuses.find((status) => status.id === activeProviderId)
    : undefined;
  const activeState = activeStatus ? resolveProviderState(activeStatus) : undefined;
  const pendingDisconnectStatus = pendingDisconnectId
    ? statuses.find((status) => status.id === pendingDisconnectId)
    : undefined;

  return (
    <div className="contents" data-testid="saas-connectors-section">
      <SaaSConnectorFeedback receipt={receipt} error={error} />

      {!statusInvalid && (
        <CustomOAuthConnectorForm
          open={customFormOpen}
          busy={busyKey === 'custom-oauth:descriptor'}
          draft={customDescriptorDraft}
          onToggle={() => setCustomFormOpen((current) => !current)}
          onChange={setCustomDescriptorDraft}
          onSave={() => void saveCustomDescriptor()}
        />
      )}

      {loading && statuses.length === 0 ? (
        ['feishu', 'google-calendar', 'tmeet'].map((providerId) => (
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
                      ? <Video className="h-7 w-7 text-badge-info" />
                      : <CalendarDays className="h-7 w-7 text-badge-info" />}
                    className="h-7 w-7"
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

            {state === 'connected'
              && status.id !== 'google-calendar'
              && status.id !== 'custom-oauth'
              && (
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
                  {isInstallRepairState(state) && (
                    <SaaSConnectorInstallAction
                      providerId={status.id}
                      repair={state === 'install_error'}
                      label={getCliConnectLabel(status, text)}
                      reinstallLabel={text.actions.reinstall}
                      disabled={rowBusy}
                      onConnect={() => void connect(status.id, status.authMode)}
                    />
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

            {!isCli && <SaaSConnectorCardFooter status={status} badge={presentation.badge} text={text} busy={rowBusy} connecting={showConnecting} onCancel={cancelConnect} />}
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
                        ? <Video className="h-8 w-8 text-badge-info" />
                        : <CalendarDays className="h-8 w-8 text-badge-info" />}
                      className="h-8 w-8"
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
                <div className={`rounded-md border px-3 py-2 text-xs ${saasConnectorDetailToneClass(activeState)}`}>
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

              {isInstallRepairState(activeState) && (
                <SaaSConnectorInstallAction
                  providerId={activeStatus.id}
                  repair={activeState === 'install_error'}
                  label={isCli ? getCliConnectLabel(activeStatus, text) : text.actions.connect}
                  reinstallLabel={text.actions.reinstall}
                  connectingLabel={text.actions.connecting}
                  connecting={isConnecting}
                  loading={isConnecting}
                  disabled={rowBusy || !canConnect}
                  onConnect={() => void connect(activeStatus.id, activeStatus.authMode)}
                />
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
                  {getTryItExamples(activeStatus, text)
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
