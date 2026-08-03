import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  FileText,
  RefreshCw,
  Shield,
  Sparkles,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ActivityContext, ActivityContextSourceKind } from '@shared/contract/activityContext';
import type { ActivityProviderDescriptor, ActivityProviderListResult } from '@shared/contract/activityProvider';
import ipcService from '../../../services/ipcService';
import {
  normalizeActivityContextResponse,
  type ActivityContextPreview,
} from '../../../services/activityContext';
import {
  getAudioCaptureStatus,
  getNativeDesktopCollectorStatus,
  listAudioSegments,
  listRecentNativeDesktopEvents,
} from '../../../services/nativeDesktop';
import {
  getDesktopShellLabel,
  isTauriMode,
  isWebMode,
} from '../../../utils/platform';
import { useI18n } from '../../../hooks/useI18n';
import {
  buildActivityPanelModel,
  getActivitySourceItemCount,
  getActivitySourceLabel,
  type ActivityNativeSnapshot,
  type ActivityPanelCopy,
  type ActivityPanelMode,
  type ActivityTone,
} from './activityPanelModel';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { PageCard, PageContent } from '../shared/PageContent';

function buildEmptyPreview(copy: ActivityPanelCopy): ActivityContextPreview {
  return {
    status: 'empty',
    recentContextSummary: copy.emptyPreview.summary,
    agentInjectionPreview: copy.emptyPreview.injection,
    sources: [],
    evidence: [],
  };
}

const EMPTY_NATIVE: ActivityNativeSnapshot = {
  collectorStatus: null,
  recentEvents: [],
  audioStatus: null,
  audioSegments: [],
  error: null,
};

function getMode(): ActivityPanelMode {
  if (isTauriMode()) return 'tauri';
  if (isWebMode()) return 'web';
  return 'desktop';
}

function toneClass(tone: ActivityTone): string {
  if (tone === 'ready') return 'border-badge-success/20 bg-emerald-500/10 text-badge-success';
  if (tone === 'blocked') return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
  return 'border-zinc-700 bg-zinc-800/70 text-zinc-300';
}

function dotClass(tone: ActivityTone): string {
  if (tone === 'ready') return 'bg-emerald-400';
  if (tone === 'blocked') return 'bg-amber-400';
  return 'bg-zinc-500';
}

function formatGeneratedAt(ms: number | null | undefined, copy: ActivityPanelCopy): string {
  if (!ms) return copy.generatedAtFallback;
  return new Intl.DateTimeFormat(copy.dateLocale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function sourceTone(status?: string | null): ActivityTone {
  return status === 'available' ? 'ready' : status === 'unavailable' ? 'blocked' : 'idle';
}

// 本地 Card 已退役（2026-07-27 UX 收尾 1.4）：统一走 PageCard 卡片语言。
const Pill: React.FC<{ tone: ActivityTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${toneClass(tone)}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${dotClass(tone)}`} />
    {children}
  </span>
);

const LoadingLine: React.FC<{ text: string }> = ({ text }) => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-500">
    {text}
  </div>
);

export const ActivityPanel: React.FC = () => {
  const { t } = useI18n();
  const ap = t.activityPanel;
  const [providers, setProviders] = useState<ActivityProviderDescriptor[]>([]);
  const [context, setContext] = useState<ActivityContext | null>(null);
  const [preview, setPreview] = useState<ActivityContextPreview>(() => buildEmptyPreview(ap));
  const [native, setNative] = useState<ActivityNativeSnapshot>(EMPTY_NATIVE);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  const mode = getMode();

  const refresh = useCallback(async () => {
    setLoading(true);
    const nextErrors: string[] = [];

    const [providerResult, contextResult] = await Promise.all([
      ipcService.invokeDomain<ActivityProviderListResult>(IPC_DOMAINS.ACTIVITY, 'listProviders')
        .catch((error) => {
          nextErrors.push(ap.errors.providerReadFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
          return null;
        }),
      ipcService.invokeDomain<ActivityContext>(IPC_DOMAINS.ACTIVITY, 'getCurrentContext')
        .catch((error) => {
          nextErrors.push(ap.errors.contextReadFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
          return null;
        }),
    ]);

    setProviders(providerResult?.providers ?? []);
    setContext(contextResult);
    setPreview(contextResult ? normalizeActivityContextResponse(contextResult) : buildEmptyPreview(ap));

    if (mode === 'tauri') {
      const now = Date.now();
      const [collectorStatus, recentEvents, audioStatus, audioSegments] = await Promise.all([
        getNativeDesktopCollectorStatus().catch((error) => {
          nextErrors.push(ap.errors.collectorStatusReadFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
          return null;
        }),
        listRecentNativeDesktopEvents(16).catch((error) => {
          nextErrors.push(ap.errors.recentEventsReadFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
          return [];
        }),
        getAudioCaptureStatus().catch((error) => {
          nextErrors.push(ap.errors.audioStatusReadFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
          return null;
        }),
        listAudioSegments(now - 24 * 60 * 60 * 1000, now).catch(() => []),
      ]);
      setNative({
        collectorStatus,
        recentEvents,
        audioStatus,
        audioSegments,
        error: null,
      });
    } else {
      setNative(EMPTY_NATIVE);
    }

    setErrors(nextErrors);
    setLoading(false);
  }, [ap, mode]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const model = useMemo(
    () => buildActivityPanelModel({
      mode,
      shellLabel: getDesktopShellLabel(),
      providers,
      context,
      preview,
      native,
      copy: ap,
    }),
    [ap, context, mode, native, preview, providers],
  );

  const sourceRows = useMemo(() => {
    const bySource = new Map((context?.sources ?? []).map((source) => [source.source, source]));
    const ordered: ActivityContextSourceKind[] = [
      'openchronicle',
      'tauri-native-desktop',
      'audio',
      'screenshot-analysis',
    ];
    return ordered.map((kind) => {
      const source = bySource.get(kind);
      return {
        kind,
        label: getActivitySourceLabel(kind, ap),
        status: source?.status ?? 'missing',
        detail: source?.status === 'available'
          ? ap.preview.sourceItems
            .replace('{count}', String(getActivitySourceItemCount(source)))
            .replace('{confidence}', source.confidence.toFixed(2))
          : source?.unavailableReason || ap.preview.sourceNotReturned,
        tone: sourceTone(source?.status),
      };
    });
  }, [ap, context]);

  return (
    <FullScreenPage testId="activity-panel" variant="inline">
      <FullScreenPageHeader
        icon={<Activity className="h-4 w-4 text-cyan-300" />}
        title="Activity"
        description={ap.header.description}
        badge={<Pill tone={model.modeTone}>{model.modeLabel}</Pill>}
        actions={(
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {ap.header.refresh}
          </button>
        )}
      />

        <PageContent width="centered" innerClassName="gap-4">
            <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass(model.modeTone)}`}>
              {model.modeDetail}
              {native.collectorStatus?.lastError ? (
                <span className="ml-2 text-amber-200">{ap.collectorErrorPrefix}{native.collectorStatus.lastError}</span>
              ) : null}
            </div>

            {errors.length > 0 && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                {errors.map((error) => (
                  <div key={error} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                ))}
              </div>
            )}

            {loading ? <LoadingLine text={ap.loading} /> : null}

            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <PageCard title={ap.cards.recentTitle} icon={<Clock3 className="h-4 w-4" />}>
                <div className="space-y-3">
                  <div>
                    <div className="text-base font-medium text-zinc-100">{model.recentHeadline}</div>
                    <div className="mt-1 text-sm text-zinc-500">{model.recentDetail}</div>
                  </div>
                  {model.recentItems.length > 0 ? (
                    <div className="space-y-2">
                      {model.recentItems.map((item) => (
                        <div key={item.key} className="grid grid-cols-[48px_1fr] gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                          <div className="font-mono text-[11px] text-zinc-600">{item.timeLabel}</div>
                          <div className="min-w-0">
                            <div className="truncate text-sm text-zinc-200">{item.title}</div>
                            <div className="truncate text-xs text-zinc-500">{item.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-sm text-zinc-500">
                      {ap.recent.fallbackSummaryNote}
                    </div>
                  )}
                </div>
              </PageCard>

              <PageCard title={ap.cards.capabilityTitle} icon={<Database className="h-4 w-4" />}>
                <div className="grid gap-2">
                  {model.capabilityRows.map((row) => (
                    <div key={row.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-zinc-200">{row.label}</div>
                        <Pill tone={row.tone}>{row.value}</Pill>
                      </div>
                      <div className="mt-1 text-xs leading-relaxed text-zinc-500">{row.detail}</div>
                    </div>
                  ))}
                </div>
              </PageCard>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <PageCard title={ap.cards.previewTitle} icon={<Sparkles className="h-4 w-4" />}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>{ap.preview.generated}{formatGeneratedAt(context?.generatedAtMs || preview.capturedAtMs, ap)}</span>
                    <span>{ap.preview.status}{preview.status === 'ready' ? ap.preview.statusReady : ap.preview.statusEmpty}</span>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-600">{ap.preview.recentContext}</div>
                    <div className="text-sm leading-relaxed text-zinc-300">{preview.recentContextSummary}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-600">{ap.preview.agentInjection}</div>
                    <div className="max-h-44 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                      {preview.agentInjectionPreview}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sourceRows.map((source) => (
                      <Pill key={source.kind} tone={source.tone}>
                        {source.label}: {source.status === 'missing' ? ap.preview.sourceMissing : source.status}
                      </Pill>
                    ))}
                  </div>
                </div>
              </PageCard>

              <PageCard title={ap.cards.providerTitle} icon={<Shield className="h-4 w-4" />}>
                <div className="space-y-2">
                  {providers.length > 0 ? providers.map((provider) => (
                    <div key={provider.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-zinc-200">{provider.label}</div>
                          <div className="mt-0.5 text-xs text-zinc-600">{provider.kind} · {provider.lifecycle} · {provider.privacyBoundary}</div>
                        </div>
                        <Pill tone={sourceTone(provider.state === 'running' || provider.state === 'available' ? 'available' : provider.state === 'error' || provider.state === 'unavailable' ? 'unavailable' : undefined)}>
                          {provider.state}
                        </Pill>
                      </div>
                      <div className="mt-1 text-xs leading-relaxed text-zinc-500">{provider.summary}</div>
                      {provider.lastError ? (
                        <div className="mt-1 text-xs text-amber-300">{provider.lastError}</div>
                      ) : null}
                    </div>
                  )) : (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-sm text-zinc-500">
                      {ap.provider.listUnavailable}
                    </div>
                  )}
                </div>
              </PageCard>
            </div>

            <PageCard title={ap.cards.boundaryTitle} icon={<FileText className="h-4 w-4" />}>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-medium text-zinc-500">{ap.boundary.injectSection}</div>
                  <div className="space-y-2">
                    {model.injectionItems.map((item) => (
                      <div key={item.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-zinc-200">{item.label}</span>
                          <Pill tone={item.tone}>{item.tone === 'ready' ? ap.boundary.injectPill : ap.boundary.noInjectPill}</Pill>
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{item.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-zinc-500">{ap.boundary.localSection}</div>
                  <div className="space-y-2">
                    {model.localEvidenceItems.map((item) => (
                      <div key={item.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-zinc-200">{item.label}</span>
                          <Pill tone={item.tone}>{item.tone === 'ready' ? ap.boundary.localKeptPill : ap.boundary.unavailablePill}</Pill>
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{item.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </PageCard>
        </PageContent>
    </FullScreenPage>
  );
};
