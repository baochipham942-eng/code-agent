// ============================================================================
// ScreenMemorySettings — unified screen memory settings entry
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Circle, Clock, Globe2, Monitor, RefreshCw, Server, Shield, Sparkles, AlertTriangle } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  ActivityProviderDescriptor,
  ActivityProviderListResult,
  ActivityProviderState,
} from '@shared/contract/activityProvider';
import {
  getDesktopShellLabel,
  isDesktopShellMode,
  isTauriMode,
  isWebMode,
} from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { NativeDesktopSection } from '../sections/NativeDesktopSection';
import { OpenchronicleSettings } from './OpenchronicleSettings';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import {
  getCurrentActivityContext,
  type ActivityContextPreview,
  type ActivityContextSourcePreview,
} from '../../../../services/activityContext';

interface StatusItem {
  label: string;
  value: string;
  tone: 'ready' | 'idle' | 'blocked';
}

const toneClass: Record<StatusItem['tone'], string> = {
  ready: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  idle: 'border-zinc-700/50 bg-zinc-800/50 text-zinc-300',
  blocked: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
};

type ProviderKind = ActivityProviderDescriptor['kind'];
type ScreenMemorySettingsText = typeof zh.settings.openchronicle.screenMemory;

const providerKindLabel: Record<ProviderKind, string> = {
  bundled: 'Bundled provider',
  sidecar: 'Sidecar provider',
  daemon: 'Daemon provider',
};

function getProviderStateLabel(
  state: ActivityProviderState,
  labels: ScreenMemorySettingsText['providerStateLabels'] = zh.settings.openchronicle.screenMemory.providerStateLabels,
): string {
  return labels[state];
}

function buildEmptyActivityContext(
  labels: ScreenMemorySettingsText['activityContext']['empty'] = zh.settings.openchronicle.screenMemory.activityContext.empty,
): ActivityContextPreview {
  return {
    status: 'empty',
    recentContextSummary: labels.recentContextSummary,
    agentInjectionPreview: labels.agentInjectionPreview,
    sources: [],
    evidence: [],
  };
}

function getShellLabel(): string {
  return getDesktopShellLabel();
}

function stateTone(state?: ActivityProviderState): StatusItem['tone'] {
  if (state === 'running' || state === 'available') return 'ready';
  if (state === 'error' || state === 'unavailable') return 'blocked';
  return 'idle';
}

function stateDotClass(state?: ActivityProviderState): string {
  if (state === 'running' || state === 'available') return 'text-emerald-400';
  if (state === 'starting' || state === 'stopping') return 'text-amber-400';
  if (state === 'error' || state === 'unavailable') return 'text-rose-400';
  return 'text-zinc-500';
}

function buildStatusItems(
  openchronicle?: ActivityProviderDescriptor,
  nativeDesktop?: ActivityProviderDescriptor,
  labels: ScreenMemorySettingsText['status'] = zh.settings.openchronicle.screenMemory.status,
  providerStateLabels: ScreenMemorySettingsText['providerStateLabels'] = zh.settings.openchronicle.screenMemory.providerStateLabels,
): StatusItem[] {
  const desktopShell = isDesktopShellMode();
  const tauri = isTauriMode();

  return [
    {
      label: labels.currentRuntime,
      value: desktopShell ? getShellLabel() : labels.webFallback,
      tone: desktopShell ? 'ready' : 'blocked',
    },
    {
      label: labels.automaticScreenMemory,
      value: openchronicle
        ? getProviderStateLabel(openchronicle.state, providerStateLabels)
        : desktopShell ? labels.openchronicleConfigurable : labels.desktopAvailable,
      tone: desktopShell ? stateTone(openchronicle?.state) : 'blocked',
    },
    {
      label: labels.manualDesktopActivity,
      value: nativeDesktop
        ? getProviderStateLabel(nativeDesktop.state, providerStateLabels)
        : tauri ? labels.nativeDesktopAvailable : labels.tauriOnly,
      tone: tauri ? stateTone(nativeDesktop?.state) : 'idle',
    },
  ];
}

const ProviderHeading: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  provider?: ActivityProviderDescriptor;
  fallbackKind?: ProviderKind;
}> = ({ icon, title, description, provider, fallbackKind }) => {
  const { t } = useI18n();
  const screenMemoryText = t.settings.openchronicle.screenMemory;
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-zinc-400">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
          {(provider || fallbackKind) && (
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
              {providerKindLabel[provider?.kind || fallbackKind!]}
            </span>
          )}
          {provider && (
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
              <Circle className={`h-2 w-2 fill-current stroke-0 ${stateDotClass(provider.state)}`} />
              {getProviderStateLabel(provider.state, screenMemoryText.providerStateLabels)}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 mt-1">{description}</p>
      </div>
    </div>
  );
};

const NativeDesktopUnavailable: React.FC = () => {
  const { t } = useI18n();
  const nativeUnavailableText = t.settings.openchronicle.screenMemory.nativeUnavailable;
  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-4">
      <div className="flex items-start gap-2 text-sm text-zinc-300">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
        <div>
          <div className="font-medium">{nativeUnavailableText.title}</div>
          <p className="text-xs text-zinc-500 mt-1">
            {nativeUnavailableText.description}
          </p>
        </div>
      </div>
    </div>
  );
};

function formatCapturedAt(
  ms?: number | null,
  labels: ScreenMemorySettingsText['activityContext']['capturedAt'] = zh.settings.openchronicle.screenMemory.activityContext.capturedAt,
): string {
  if (!ms) return labels.none;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function SourceBadge({ source }: { source: ActivityContextSourcePreview }) {
  const className = {
    automatic_background: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300',
    manual_capture: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
    meeting_audio: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
    screenshot_analysis: 'border-purple-500/20 bg-purple-500/10 text-purple-300',
    unknown: 'border-zinc-600 bg-zinc-800 text-zinc-400',
  }[source.kind];

  return (
    <span
      title={source.summary}
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${className}`}
    >
      {source.label}
    </span>
  );
}

const PreviewBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3">
    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</div>
    <div className="text-sm leading-relaxed text-zinc-300">{children}</div>
  </div>
);

export const ActivityContextPreviewPanel: React.FC<{
  context: ActivityContextPreview;
  degraded?: string | null;
}> = ({ context, degraded }) => {
  const { t } = useI18n();
  const activityText = t.settings.openchronicle.screenMemory.activityContext;
  return (
    <section className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <Sparkles className="h-4 w-4 text-cyan-300" />
            {activityText.title}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            <Clock className="h-3.5 w-3.5" />
            {formatCapturedAt(context.capturedAtMs, activityText.capturedAt)}
          </div>
        </div>
        {degraded ? (
          <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
            {activityText.degraded}
          </span>
        ) : null}
      </div>

      {degraded ? (
        <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {degraded}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {context.sources.length > 0 ? (
          context.sources.map((source, index) => (
            <SourceBadge key={`${source.kind}:${index}`} source={source} />
          ))
        ) : (
          <span className="text-xs text-zinc-500">{activityText.noSources}</span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PreviewBlock title={activityText.recentContextPreview}>
          {context.recentContextSummary}
        </PreviewBlock>
        <PreviewBlock title={activityText.agentInjectionPreview}>
          {context.agentInjectionPreview}
        </PreviewBlock>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <div className="min-w-0 text-xs text-zinc-500">
          {context.evidence.length > 0
            ? context.evidence.join(' · ')
            : activityText.evidenceFallback}
        </div>
      </div>
    </section>
  );
};

export const ScreenMemorySettings: React.FC = () => {
  const { t } = useI18n();
  const screenMemoryText = t.settings.openchronicle.screenMemory;
  const emptyActivityContext = useMemo(
    () => buildEmptyActivityContext(screenMemoryText.activityContext.empty),
    [screenMemoryText.activityContext.empty],
  );
  const [activityContext, setActivityContext] = useState<ActivityContextPreview>(() => buildEmptyActivityContext());
  const [providers, setProviders] = useState<ActivityProviderDescriptor[]>([]);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);
  const web = isWebMode();
  const tauri = isTauriMode();

  const openchronicleProvider = useMemo(
    () => providers.find((provider) => provider.id === 'openchronicle'),
    [providers]
  );
  const nativeDesktopProvider = useMemo(
    () => providers.find((provider) => provider.id === 'tauri-native-desktop'),
    [providers]
  );
  const statusItems = buildStatusItems(
    openchronicleProvider,
    nativeDesktopProvider,
    screenMemoryText.status,
    screenMemoryText.providerStateLabels,
  );

  const refreshActivityContext = useCallback(async () => {
    setContextLoading(true);
    try {
      const [providerResult, contextResult] = await Promise.all([
        ipcService.invokeDomain<ActivityProviderListResult>(IPC_DOMAINS.ACTIVITY, 'listProviders'),
        getCurrentActivityContext(),
      ]);
      setProviders(providerResult.providers);
      setActivityContext(contextResult);
      setContextError(null);
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error));
      setActivityContext({
        ...emptyActivityContext,
        recentContextSummary: screenMemoryText.activityContext.error.recentContextUnavailable,
        agentInjectionPreview: screenMemoryText.activityContext.error.agentInjectionUnavailable,
      });
    } finally {
      setContextLoading(false);
    }
  }, [emptyActivityContext, screenMemoryText.activityContext.error.agentInjectionUnavailable, screenMemoryText.activityContext.error.recentContextUnavailable]);

  useEffect(() => {
    if (!web) {
      refreshActivityContext();
    }
  }, [refreshActivityContext, web]);

  if (web) {
    return (
      <SettingsPage
        title={t.settings.tabs.openchronicle}
        description={screenMemoryText.webDescription}
      >
        <WebModeBanner />
        <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-4 text-sm text-zinc-400">
          {screenMemoryText.webBody}
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={t.settings.tabs.openchronicle}
      description={screenMemoryText.pageDescription}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {statusItems.map((item) => (
          <div key={item.label} className={`rounded-lg border px-3 py-2 ${toneClass[item.tone]}`}>
            <div className="text-[11px] opacity-75">{item.label}</div>
            <div className="text-sm font-medium mt-0.5">{item.value}</div>
          </div>
        ))}
      </div>

      <SettingsSection title={screenMemoryText.captureSection.title}>
        <ProviderHeading
          icon={<Server className="w-4 h-4" />}
          title={screenMemoryText.captureSection.openchronicleTitle}
          description={openchronicleProvider?.summary || screenMemoryText.captureSection.openchronicleDescription}
          provider={openchronicleProvider}
          fallbackKind="daemon"
        />
        <OpenchronicleSettings embedded />
      </SettingsSection>

      <SettingsDetails
        title={screenMemoryText.diagnostics.title}
        description={screenMemoryText.diagnostics.description}
        actions={(
          <button
            onClick={refreshActivityContext}
            disabled={contextLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${contextLoading ? 'animate-spin' : ''}`} />
            {screenMemoryText.refresh}
          </button>
        )}
      >
        <div className="space-y-4">
          <ProviderHeading
            icon={<Sparkles className="w-4 h-4" />}
            title={screenMemoryText.diagnostics.activityTitle}
            description={screenMemoryText.diagnostics.activityDescription}
          />
          <ActivityContextPreviewPanel context={activityContext} degraded={contextError} />

          <ProviderHeading
            icon={tauri ? <Monitor className="w-4 h-4" /> : <Globe2 className="w-4 h-4" />}
            title={screenMemoryText.diagnostics.nativeDesktopTitle}
            description={nativeDesktopProvider?.summary || screenMemoryText.diagnostics.nativeDesktopDescription}
            provider={nativeDesktopProvider}
            fallbackKind="bundled"
          />
          {tauri ? (
            <div className="h-[460px] rounded-lg border border-zinc-700/60 overflow-hidden bg-zinc-900">
              <NativeDesktopSection />
            </div>
          ) : (
            <NativeDesktopUnavailable />
          )}
        </div>
      </SettingsDetails>
    </SettingsPage>
  );
};
