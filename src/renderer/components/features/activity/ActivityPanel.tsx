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
  X,
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
import {
  buildActivityPanelModel,
  getActivitySourceItemCount,
  getActivitySourceLabel,
  type ActivityNativeSnapshot,
  type ActivityPanelMode,
  type ActivityTone,
} from './activityPanelModel';

const EMPTY_PREVIEW: ActivityContextPreview = {
  status: 'empty',
  recentContextSummary: '暂无可用屏幕上下文。',
  agentInjectionPreview: '暂无内容会注入 agent。',
  sources: [],
  evidence: [],
};

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
  if (tone === 'ready') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
  if (tone === 'blocked') return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
  return 'border-zinc-700 bg-zinc-800/70 text-zinc-300';
}

function dotClass(tone: ActivityTone): string {
  if (tone === 'ready') return 'bg-emerald-400';
  if (tone === 'blocked') return 'bg-amber-400';
  return 'bg-zinc-500';
}

function formatGeneratedAt(ms?: number | null): string {
  if (!ms) return '尚未生成';
  return new Intl.DateTimeFormat('zh-CN', {
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

const Card: React.FC<{
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, icon, children, className = '' }) => (
  <section className={`rounded-lg border border-zinc-800 bg-zinc-900/70 ${className}`}>
    <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
      <div className="text-zinc-500">{icon}</div>
      <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
    </div>
    <div className="p-4">{children}</div>
  </section>
);

const Pill: React.FC<{ tone: ActivityTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${toneClass(tone)}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${dotClass(tone)}`} />
    {children}
  </span>
);

const LoadingLine: React.FC = () => (
  <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-500">
    正在读取 Activity 上下文...
  </div>
);

export const ActivityPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [providers, setProviders] = useState<ActivityProviderDescriptor[]>([]);
  const [context, setContext] = useState<ActivityContext | null>(null);
  const [preview, setPreview] = useState<ActivityContextPreview>(EMPTY_PREVIEW);
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
          nextErrors.push(`provider 状态读取失败：${error instanceof Error ? error.message : String(error)}`);
          return null;
        }),
      ipcService.invokeDomain<ActivityContext>(IPC_DOMAINS.ACTIVITY, 'getCurrentContext')
        .catch((error) => {
          nextErrors.push(`ActivityContext 读取失败：${error instanceof Error ? error.message : String(error)}`);
          return null;
        }),
    ]);

    setProviders(providerResult?.providers ?? []);
    setContext(contextResult);
    setPreview(contextResult ? normalizeActivityContextResponse(contextResult) : EMPTY_PREVIEW);

    if (mode === 'tauri') {
      const now = Date.now();
      const [collectorStatus, recentEvents, audioStatus, audioSegments] = await Promise.all([
        getNativeDesktopCollectorStatus().catch((error) => {
          nextErrors.push(`桌面采集状态读取失败：${error instanceof Error ? error.message : String(error)}`);
          return null;
        }),
        listRecentNativeDesktopEvents(16).catch((error) => {
          nextErrors.push(`最近桌面活动读取失败：${error instanceof Error ? error.message : String(error)}`);
          return [];
        }),
        getAudioCaptureStatus().catch((error) => {
          nextErrors.push(`音频状态读取失败：${error instanceof Error ? error.message : String(error)}`);
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
  }, [mode]);

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
    }),
    [context, mode, native, preview, providers],
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
        label: getActivitySourceLabel(kind),
        status: source?.status ?? 'missing',
        detail: source?.status === 'available'
          ? `${getActivitySourceItemCount(source)} 条 item，confidence ${source.confidence.toFixed(2)}`
          : source?.unavailableReason || '后端没有返回该来源。',
        tone: sourceTone(source?.status),
      };
    });
  }, [context]);

  return (
    <div className="fixed inset-0 z-50 flex bg-zinc-950/95 text-zinc-200 backdrop-blur-sm">
      <div className="flex h-full w-full flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10">
              <Activity className="h-4 w-4 text-cyan-300" />
            </div>
            <div>
              <div className="text-sm font-medium text-zinc-100">Activity</div>
              <div className="text-xs text-zinc-500">观察、上下文、prompt 注入边界</div>
            </div>
            <Pill tone={model.modeTone}>{model.modeLabel}</Pill>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭 Activity"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto flex max-w-6xl flex-col gap-4">
            <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass(model.modeTone)}`}>
              {model.modeDetail}
              {native.collectorStatus?.lastError ? (
                <span className="ml-2 text-amber-200">采集器错误：{native.collectorStatus.lastError}</span>
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

            {loading ? <LoadingLine /> : null}

            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <Card title="今天/最近发生了什么" icon={<Clock3 className="h-4 w-4" />}>
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
                      没有桌面事件列表时，Activity 会退回到统一上下文摘要。
                    </div>
                  )}
                </div>
              </Card>

              <Card title="当前会话可用哪些上下文" icon={<Database className="h-4 w-4" />}>
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
              </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <Card title="ActivityContext 当前预览" icon={<Sparkles className="h-4 w-4" />}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>生成：{formatGeneratedAt(context?.generatedAtMs || preview.capturedAtMs)}</span>
                    <span>状态：{preview.status === 'ready' ? '可用' : '空态'}</span>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-600">最近上下文</div>
                    <div className="text-sm leading-relaxed text-zinc-300">{preview.recentContextSummary}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-600">将进入 agent 的文本预览</div>
                    <div className="max-h-44 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
                      {preview.agentInjectionPreview}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sourceRows.map((source) => (
                      <Pill key={source.kind} tone={source.tone}>
                        {source.label}: {source.status === 'missing' ? '未返回' : source.status}
                      </Pill>
                    ))}
                  </div>
                </div>
              </Card>

              <Card title="Provider 状态" icon={<Shield className="h-4 w-4" />}>
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
                      provider 列表暂不可用，ActivityContext 预览仍可单独降级显示。
                    </div>
                  )}
                </div>
              </Card>
            </div>

            <Card title="哪些进入 prompt，哪些只是本地证据" icon={<FileText className="h-4 w-4" />}>
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-medium text-zinc-500">会注入 agent</div>
                  <div className="space-y-2">
                    {model.injectionItems.map((item) => (
                      <div key={item.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-zinc-200">{item.label}</span>
                          <Pill tone={item.tone}>{item.tone === 'ready' ? '进入 prompt' : '不注入'}</Pill>
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{item.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium text-zinc-500">只作为本地证据</div>
                  <div className="space-y-2">
                    {model.localEvidenceItems.map((item) => (
                      <div key={item.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-zinc-200">{item.label}</span>
                          <Pill tone={item.tone}>{item.tone === 'ready' ? '本地保留' : '不可用'}</Pill>
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{item.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
};
