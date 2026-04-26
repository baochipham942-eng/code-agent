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

const providerKindLabel: Record<ProviderKind, string> = {
  bundled: 'Bundled provider',
  sidecar: 'Sidecar provider',
  daemon: 'Daemon provider',
};

const providerStateLabel: Record<ActivityProviderState, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  available: '可用',
  unavailable: '不可用',
  error: '异常',
};

const EMPTY_CONTEXT: ActivityContextPreview = {
  status: 'empty',
  recentContextSummary: '正在读取最近屏幕上下文。',
  agentInjectionPreview: '正在读取将注入 agent 的内容。',
  sources: [],
  evidence: [],
};

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
  nativeDesktop?: ActivityProviderDescriptor
): StatusItem[] {
  const desktopShell = isDesktopShellMode();
  const tauri = isTauriMode();

  return [
    {
      label: '当前运行',
      value: desktopShell ? getShellLabel() : 'Web 降级',
      tone: desktopShell ? 'ready' : 'blocked',
    },
    {
      label: '自动屏幕记忆',
      value: openchronicle
        ? providerStateLabel[openchronicle.state]
        : desktopShell ? 'OpenChronicle 可配置' : '桌面版可用',
      tone: desktopShell ? stateTone(openchronicle?.state) : 'blocked',
    },
    {
      label: '手动桌面活动',
      value: nativeDesktop
        ? providerStateLabel[nativeDesktop.state]
        : tauri ? 'Native Desktop 可用' : '仅 Tauri 可用',
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
}> = ({ icon, title, description, provider, fallbackKind }) => (
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
            {providerStateLabel[provider.state]}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500 mt-1">{description}</p>
    </div>
  </div>
);

const NativeDesktopUnavailable: React.FC = () => (
  <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-4">
    <div className="flex items-start gap-2 text-sm text-zinc-300">
      <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
      <div>
        <div className="font-medium">当前桌面壳没有 Tauri Native Desktop provider</div>
        <p className="text-xs text-zinc-500 mt-1">
          这里保留入口和能力说明；手动桌面活动采集、截图和录音控制只在 Tauri 桌面版执行。
        </p>
      </div>
    </div>
  </div>
);

function formatCapturedAt(ms?: number | null): string {
  if (!ms) return '尚无时间';
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
}> = ({ context, degraded }) => (
  <section className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-4">
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <Sparkles className="h-4 w-4 text-cyan-300" />
          ActivityContext 预览
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
          <Clock className="h-3.5 w-3.5" />
          {formatCapturedAt(context.capturedAtMs)}
        </div>
      </div>
      {degraded ? (
        <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
          降级
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
        <span className="text-xs text-zinc-500">暂无来源</span>
      )}
    </div>

    <div className="grid gap-3 md:grid-cols-2">
      <PreviewBlock title="最近上下文预览">
        {context.recentContextSummary}
      </PreviewBlock>
      <PreviewBlock title="将注入 agent 的内容预览">
        {context.agentInjectionPreview}
      </PreviewBlock>
    </div>

    <div className="mt-3 flex items-start gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2">
      <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <div className="min-w-0 text-xs text-zinc-500">
        {context.evidence.length > 0
          ? context.evidence.join(' · ')
          : '证据预览只展示摘要，本地截图路径和文件路径不会在这里展开。'}
      </div>
    </div>
  </section>
);

export const ScreenMemorySettings: React.FC = () => {
  const [activityContext, setActivityContext] = useState<ActivityContextPreview>(EMPTY_CONTEXT);
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
  const statusItems = buildStatusItems(openchronicleProvider, nativeDesktopProvider);

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
        ...EMPTY_CONTEXT,
        recentContextSummary: 'ActivityContext 暂不可用。',
        agentInjectionPreview: '本轮不会从屏幕记忆注入额外上下文。',
      });
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!web) {
      refreshActivityContext();
    }
  }, [refreshActivityContext, web]);

  if (web) {
    return (
      <SettingsPage
        title="屏幕记忆"
        description="Web 模式不直接控制本机屏幕记忆。请在桌面版里配置。"
      >
        <WebModeBanner />
        <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-4 text-sm text-zinc-400">
          统一入口已保留，但 OpenChronicle daemon 和 Native Desktop provider 都需要桌面壳能力。
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="屏幕记忆"
      description="配置屏幕记忆采集、注入和隐私边界。预览与桌面活动控制默认收在诊断区。"
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {statusItems.map((item) => (
          <div key={item.label} className={`rounded-lg border px-3 py-2 ${toneClass[item.tone]}`}>
            <div className="text-[11px] opacity-75">{item.label}</div>
            <div className="text-sm font-medium mt-0.5">{item.value}</div>
          </div>
        ))}
      </div>

      <SettingsSection title="采集与注入设置">
        <ProviderHeading
          icon={<Server className="w-4 h-4" />}
          title="自动屏幕记忆 / OpenChronicle 外部 provider"
          description={openchronicleProvider?.summary || '通过 Code Agent 桥设置 OpenChronicle daemon，不改变采集内核和后台生命周期。'}
          provider={openchronicleProvider}
          fallbackKind="daemon"
        />
        <OpenchronicleSettings embedded />
      </SettingsSection>

      <SettingsDetails
        title="诊断与预览"
        description="ActivityContext 预览和手动桌面活动控制用于排查采集链路，默认收起。"
        actions={(
          <button
            onClick={refreshActivityContext}
            disabled={contextLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${contextLoading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        )}
      >
        <div className="space-y-4">
          <ProviderHeading
            icon={<Sparkles className="w-4 h-4" />}
            title="统一 ActivityContext 预览"
            description="预览最近屏幕上下文和即将注入 agent 的摘要，不展示本地截图路径。"
          />
          <ActivityContextPreviewPanel context={activityContext} degraded={contextError} />

          <ProviderHeading
            icon={tauri ? <Monitor className="w-4 h-4" /> : <Globe2 className="w-4 h-4" />}
            title="手动桌面活动 / Tauri Native Desktop provider"
            description={nativeDesktopProvider?.summary || 'Tauri 桌面版可直接查看和控制本机桌面活动采集；其他桌面壳只展示能力边界。'}
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
