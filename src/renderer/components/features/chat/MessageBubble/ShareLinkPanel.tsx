import React, { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import type { DeliverableShareLinkInfo } from '@shared/contract';
import { SHARE_SERVICE } from '@shared/constants';
import { IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../../../../stores/appStore';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import ipcService from '../../../../services/ipcService';
import { Button, Modal } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';

const CONSENT_STORAGE_KEY = 'neo-share-upload-consent-v1';

export interface ShareLinkPanelProps {
  isOpen: boolean;
  filePath: string;
  title: string;
  onClose: () => void;
  onInfoChange?: (info: DeliverableShareLinkInfo) => void;
}

function hasUploadConsent(): boolean {
  try {
    return window.localStorage.getItem(CONSENT_STORAGE_KEY) === 'confirmed';
  } catch {
    return false;
  }
}

function rememberUploadConsent(): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'confirmed');
  } catch {
    // Consent still applies to this explicit click; storage may be unavailable in hardened contexts.
  }
}

export const ShareLinkPanel: React.FC<ShareLinkPanelProps> = ({
  isOpen,
  filePath,
  title,
  onClose,
  onInfoChange,
}) => {
  const { t, language } = useI18n();
  const labels = t.deliverable.shareLink;
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const [info, setInfo] = useState<DeliverableShareLinkInfo | null>(null);
  const [ttlSeconds, setTtlSeconds] = useState<number>(SHARE_SERVICE.TTL_PRESETS_SECONDS[0]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<'create' | 'ttl' | 'push' | 'revoke' | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [consented, setConsented] = useState(hasUploadConsent);

  const applyInfo = (next: DeliverableShareLinkInfo) => {
    setInfo(next);
    if (next.share) setTtlSeconds(next.share.ttlSeconds);
    onInfoChange?.(next);
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    void ipcService.invokeDomain<DeliverableShareLinkInfo>(
      IPC_DOMAINS.WORKSPACE,
      'getShareLink',
      { filePath },
    ).then((next) => {
      if (!cancelled) applyInfo(next);
    }).catch(() => {
      if (!cancelled) toast.error(labels.loadFailed);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, isOpen]);

  const actionError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('File exceeds 25 MB')) {
      toast.error(labels.fileTooLarge);
      return;
    }
    if (message.includes('Share service token not configured')) {
      toast.error(labels.tokenMissing);
      return;
    }
    toast.error(`${labels.actionFailed}: ${message}`);
  };

  const create = async () => {
    if (busyAction) return;
    setBusyAction('create');
    try {
      const next = await ipcService.invokeDomain<DeliverableShareLinkInfo>(
        IPC_DOMAINS.WORKSPACE,
        'createShareLink',
        { filePath, ttlSeconds },
      );
      rememberUploadConsent();
      setConsented(true);
      applyInfo(next);
      toast.success(labels.created);
    } catch (error) {
      actionError(error);
    } finally {
      setBusyAction(null);
    }
  };

  const updateTtl = async (nextTtl: number) => {
    setTtlSeconds(nextTtl);
    if (!info?.share || info.share.revokedAt || busyAction) return;
    setBusyAction('ttl');
    try {
      const next = await ipcService.invokeDomain<DeliverableShareLinkInfo>(
        IPC_DOMAINS.WORKSPACE,
        'updateShareLinkTtl',
        { filePath, ttlSeconds: nextTtl },
      );
      applyInfo(next);
      toast.success(labels.ttlUpdated);
    } catch (error) {
      setTtlSeconds(info.share.ttlSeconds);
      actionError(error);
    } finally {
      setBusyAction(null);
    }
  };

  const pushLatest = async () => {
    if (busyAction) return;
    setBusyAction('push');
    try {
      const next = await ipcService.invokeDomain<DeliverableShareLinkInfo>(
        IPC_DOMAINS.WORKSPACE,
        'pushShareLink',
        { filePath },
      );
      applyInfo(next);
      if (next.share?.lastError) throw new Error(next.share.lastError);
      toast.success(labels.pushed);
    } catch (error) {
      actionError(error);
    } finally {
      setBusyAction(null);
    }
  };

  const revoke = async () => {
    setConfirmRevoke(false);
    if (busyAction) return;
    setBusyAction('revoke');
    try {
      const next = await ipcService.invokeDomain<DeliverableShareLinkInfo>(
        IPC_DOMAINS.WORKSPACE,
        'revokeShareLink',
        { filePath },
      );
      applyInfo(next);
      toast.success(labels.revokedToast);
    } catch (error) {
      actionError(error);
    } finally {
      setBusyAction(null);
    }
  };

  const copyLink = async () => {
    if (!info?.share?.url) return;
    try {
      await navigator.clipboard.writeText(info.share.url);
      toast.success(labels.copied);
    } catch (error) {
      actionError(error);
    }
  };

  const share = info?.share ?? null;
  const expired = Boolean(share?.expiresAt && share.expiresAt <= Date.now());
  const inactive = Boolean(share?.revokedAt || expired);
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={labels.title}
        size="md"
        portal
        headerIcon={<Link className="h-5 w-5 text-badge-info" />}
      >
        <div className="space-y-4" data-testid="share-link-panel">
          <p className="truncate text-xs text-zinc-500" title={title}>{title}</p>

          {loading && <p className="py-8 text-center text-xs text-zinc-500">{labels.loading}</p>}

          {!loading && info && !info.tokenConfigured && (
            <div className="rounded-lg border border-badge-warning/30 bg-amber-500/10 p-3 text-xs text-zinc-300" data-testid="share-link-token-missing">
              <p>{labels.tokenMissing}</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => openSettingsTab('search')}>
                {labels.openSettings}
              </Button>
            </div>
          )}

          {!loading && info && !share && (
            <div className="space-y-4" data-testid="share-link-empty">
              {!consented && (
                <div className="rounded-lg border border-badge-info/25 bg-cyan-500/[0.045] p-3 text-xs leading-5 text-zinc-300">
                  <div className="mb-1 flex items-center gap-2 font-medium text-zinc-200">
                    <Upload className="h-4 w-4 text-badge-info" />
                    {labels.firstUploadTitle}
                  </div>
                  {labels.firstUploadDescription}
                </div>
              )}
              <TtlSelector value={ttlSeconds} disabled={Boolean(busyAction)} onChange={(value) => setTtlSeconds(value)} labels={labels} />
              <Button
                variant="primary"
                fullWidth
                loading={busyAction === 'create'}
                disabled={!info.tokenConfigured}
                leftIcon={<Upload className="h-4 w-4" />}
                onClick={() => void create()}
              >
                {labels.uploadAndCreate}
              </Button>
            </div>
          )}

          {!loading && info && share && (
            <div className="space-y-4" data-testid={inactive ? 'share-link-inactive' : info.stale ? 'share-link-stale' : 'share-link-active'}>
              <div className={`rounded-lg border p-3 ${inactive ? 'border-border-muted bg-surface-subtle opacity-70' : 'border-badge-info/25 bg-cyan-500/[0.045]'}`}>
                <label className="mb-1.5 block text-[11px] text-zinc-500">{labels.linkLabel}</label>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={share.url}
                    className="h-8 min-w-0 flex-1 rounded border border-border-muted bg-surface-canvas px-2.5 font-mono text-xs text-zinc-300 outline-none"
                    aria-label={labels.linkLabel}
                  />
                  <Button variant="secondary" size="sm" onClick={() => void copyLink()} leftIcon={<Copy className="h-3.5 w-3.5" />}>
                    {labels.copy}
                  </Button>
                </div>
              </div>

              {inactive ? (
                <div className="rounded-lg border border-border-muted bg-surface-subtle p-3 text-xs text-zinc-400">
                  <p className="font-medium text-zinc-300">{expired ? labels.expired : labels.revoked}</p>
                  <p className="mt-1 leading-5">{labels.gracePeriod}</p>
                </div>
              ) : (
                <TtlSelector value={ttlSeconds} disabled={Boolean(busyAction) || !info.tokenConfigured} onChange={(value) => void updateTtl(value)} labels={labels} />
              )}

              {!inactive && (
                <div className="space-y-2 rounded-lg border border-border-muted bg-surface-subtle p-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-500">{labels.expiresLabel}</span>
                    <span className="text-zinc-300">{share.expiresAt === null ? labels.permanent : new Date(share.expiresAt).toLocaleString(locale)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-500">{labels.contentLabel}</span>
                    {info.stale ? (
                      <span className="flex items-center gap-2 text-badge-warning">
                        {labels.stale.replace('{version}', String(info.latestPublishedVersion ?? share.pushedVersion))}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:underline disabled:opacity-50"
                          disabled={Boolean(busyAction) || !info.tokenConfigured}
                          onClick={() => void pushLatest()}
                        >
                          <RefreshCw className={`h-3 w-3 ${busyAction === 'push' ? 'animate-spin' : ''}`} />
                          {labels.retryPush}
                        </button>
                      </span>
                    ) : (
                      <span className="text-badge-success">{labels.contentVersion.replace('{version}', String(share.pushedVersion))}</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5 text-zinc-500"><ShieldCheck className="h-3.5 w-3.5" />{labels.audienceLabel}</span>
                    <span className="text-zinc-300">{labels.anyoneWithLink}</span>
                  </div>
                </div>
              )}

              {inactive ? (
                <Button
                  variant="primary"
                  fullWidth
                  loading={busyAction === 'create'}
                  disabled={!info.tokenConfigured}
                  leftIcon={<Link className="h-4 w-4" />}
                  onClick={() => void create()}
                >
                  {labels.createAgain}
                </Button>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <a className="inline-flex items-center gap-1 text-xs text-badge-info hover:underline" href={share.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />{labels.openLink}
                  </a>
                  <Button variant="danger" size="sm" disabled={Boolean(busyAction) || !info.tokenConfigured} onClick={() => setConfirmRevoke(true)}>
                    {labels.revoke}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmRevoke}
        title={labels.revokeConfirmTitle}
        message={<div className="space-y-2 text-sm leading-6 text-zinc-400"><p>{labels.revokeConfirmDescription}</p><p>{labels.gracePeriod}</p></div>}
        variant="danger"
        confirmText={labels.revoke}
        cancelText={t.common.cancel}
        onConfirm={() => void revoke()}
        onCancel={() => setConfirmRevoke(false)}
      />
    </>
  );
};

interface TtlSelectorProps {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  labels: ReturnType<typeof useI18n>['t']['deliverable']['shareLink'];
}

const TtlSelector: React.FC<TtlSelectorProps> = ({ value, disabled, onChange, labels }) => (
  <div className="space-y-1.5">
    <span className="text-xs text-zinc-500">{labels.ttlLabel}</span>
    <div className="grid grid-cols-3 gap-1 rounded-lg border border-border-muted bg-surface-canvas p-1">
      {SHARE_SERVICE.TTL_PRESETS_SECONDS.map((ttl, index) => (
        <button
          key={ttl}
          type="button"
          disabled={disabled}
          aria-pressed={value === ttl}
          className={`rounded-md px-2 py-1.5 text-xs transition-colors disabled:opacity-50 ${value === ttl ? 'bg-btn-secondary text-zinc-100' : 'text-zinc-500 hover:bg-btn-ghost-hover hover:text-zinc-300'}`}
          onClick={() => onChange(ttl)}
        >
          {[labels.sevenDays, labels.thirtyDays, labels.permanent][index]}
        </button>
      ))}
    </div>
  </div>
);
