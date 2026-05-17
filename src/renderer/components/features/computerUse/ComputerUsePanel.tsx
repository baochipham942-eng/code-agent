import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  AppWindow,
  Circle,
  Eye,
  Loader2,
  Lock,
  MousePointerClick,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SquareMousePointer,
  ZapOff,
} from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import {
  getFrontmostDesktopContext,
  getNativeDesktopCapabilities,
  getNativeDesktopCollectorStatus,
  getNativeDesktopPermissionStatus,
  isNativeDesktopAvailable,
  listComputerSurfaceElements,
  listRecentNativeDesktopEvents,
  observeComputerSurface,
  readComputerSurfaceState,
  type ComputerSurfaceElementsResult,
  type ComputerSurfaceObservationResult,
  type ComputerSurfaceState,
  type DesktopActivityEvent,
  type FrontmostContextSnapshot,
  type NativeDesktopCapabilities,
  type NativeDesktopCollectorStatus,
  type NativePermissionSnapshot,
  type NativePermissionStatus,
} from '../../../services/nativeDesktop';
import {
  buildComputerUseTargets,
  buildRecentComputerUseAction,
  describeComputerUseFailures,
  getNativePermissionStatus,
  type ComputerUseFailureExplanation,
  type ComputerUseTarget,
} from '../../../utils/computerUseWorkbench';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';

type StatusTone = 'ready' | 'blocked' | 'warning' | 'neutral';

interface ElementCandidate {
  id: string;
  role: string;
  label: string;
  axPath: string | null;
  enabled: boolean | null;
}

function formatTime(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return '未知';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusToneClass(tone: StatusTone): string {
  switch (tone) {
    case 'ready':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'blocked':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    default:
      return 'border-zinc-700/60 bg-zinc-800/70 text-zinc-400';
  }
}

function permissionTone(permission: NativePermissionStatus | null): StatusTone {
  if (!permission) return 'warning';
  if (permission.status === 'granted') return 'ready';
  if (permission.status === 'denied') return 'blocked';
  if (permission.status === 'unsupported') return 'neutral';
  return 'warning';
}

function permissionLabel(permission: NativePermissionStatus | null): string {
  if (!permission) return '未探测';
  switch (permission.status) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '未授权';
    case 'unsupported':
      return '不支持';
    default:
      return '未确认';
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function toElementCandidates(result: ComputerSurfaceElementsResult | null): ElementCandidate[] {
  const metadata = result?.metadata;
  const raw = metadata?.elements || metadata?.candidates;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.slice(0, 16).map((item, index) => {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const role = firstString(record, ['role', 'subrole', 'type']) || 'AXElement';
    const label =
      firstString(record, ['name', 'title', 'label', 'description', 'text', 'value'])
      || firstString(record, ['selector'])
      || '未命名元素';
    const axPath = firstString(record, ['axPath', 'path']);
    const enabled = typeof record.enabled === 'boolean' ? record.enabled : null;
    const indexValue = typeof record.index === 'number' ? record.index : index + 1;
    return {
      id: `${axPath || role}-${indexValue}`,
      role,
      label,
      axPath,
      enabled,
    };
  });
}

function extractMetadataNumber(result: ComputerSurfaceElementsResult | null, key: string): number | null {
  const value = result?.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function targetSourceLabel(source: ComputerUseTarget['source']): string {
  switch (source) {
    case 'frontmost':
      return '前台';
    case 'surface':
      return 'Surface';
    case 'approved':
      return '已批准';
    case 'denied':
      return '已拒绝';
    default:
      return '最近';
  }
}

function failureToneClass(tone: ComputerUseFailureExplanation['tone']): string {
  if (tone === 'blocked') return 'border-rose-500/20 bg-rose-500/10 text-rose-100';
  if (tone === 'warning') return 'border-amber-500/20 bg-amber-500/10 text-amber-100';
  return 'border-zinc-700/60 bg-zinc-900/60 text-zinc-300';
}

const StatusPill: React.FC<{ label: string; tone: StatusTone }> = ({ label, tone }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${statusToneClass(tone)}`}>
    {label}
  </span>
);

const BoundaryCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone: StatusTone;
}> = ({ icon, title, detail, tone }) => (
  <div className={`rounded-lg border p-3 ${statusToneClass(tone)}`}>
    <div className="flex items-center gap-2 text-sm font-medium">
      {icon}
      {title}
    </div>
    <p className="mt-1 text-xs leading-relaxed opacity-80">{detail}</p>
  </div>
);

function createUnavailableSurfaceState(): ComputerSurfaceState {
  return {
    id: 'computer-surface-web-unavailable',
    mode: 'background_surface_unavailable',
    platform: 'web',
    ready: false,
    background: false,
    approvalScope: 'blocked',
    safetyNote: 'Web 模式没有 native desktop bridge；这里仅展示 Computer Use 的能力边界和降级原因。',
    targetApp: null,
    blockedReason: 'Tauri runtime not available',
    approvedApps: [],
    deniedApps: [],
    lastAction: null,
    lastSnapshot: null,
    failureKind: 'evidence_unavailable',
    blockingReasons: ['Tauri runtime not available'],
    recommendedAction: '在桌面壳中打开后再读取窗口、截图和 AX evidence。',
    evidenceSummary: ['Web mode: native desktop evidence unavailable'],
    axQuality: null,
  };
}

export const ComputerUsePanel: React.FC = () => {
  const setShowComputerUsePanel = useAppStore((state) => state.setShowComputerUsePanel);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [capabilities, setCapabilities] = useState<NativeDesktopCapabilities | null>(null);
  const [permissionSnapshot, setPermissionSnapshot] = useState<NativePermissionSnapshot | null>(null);
  const [collectorStatus, setCollectorStatus] = useState<NativeDesktopCollectorStatus | null>(null);
  const [frontmost, setFrontmost] = useState<FrontmostContextSnapshot | null>(null);
  const [recentEvents, setRecentEvents] = useState<DesktopActivityEvent[]>([]);
  const [surface, setSurface] = useState<ComputerSurfaceState | null>(null);
  const [observation, setObservation] = useState<ComputerSurfaceObservationResult | null>(null);
  const [desktopProviderError, setDesktopProviderError] = useState<string | null>(null);
  const [observeError, setObserveError] = useState<string | null>(null);
  const [elementsResult, setElementsResult] = useState<ComputerSurfaceElementsResult | null>(null);
  const [elementsError, setElementsError] = useState<string | null>(null);
  const [selectedTargetApp, setSelectedTargetApp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [elementsLoading, setElementsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setDesktopProviderError(null);
    setObserveError(null);
    const hasNative = isNativeDesktopAvailable();
    setNativeAvailable(hasNative);

    if (!hasNative) {
      setSurface(createUnavailableSurfaceState());
      setObservation(null);
      setCapabilities(null);
      setPermissionSnapshot(null);
      setCollectorStatus(null);
      setFrontmost(null);
      setRecentEvents([]);
      setDesktopProviderError('Web 模式没有 native desktop bridge');
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      const [surfaceResponse, observeResponse] = await Promise.allSettled([
        readComputerSurfaceState(),
        observeComputerSurface({ includeScreenshot: false }),
      ]);

      let nextSurface: ComputerSurfaceState | null = null;
      if (surfaceResponse.status === 'fulfilled') {
        if (surfaceResponse.value.success && surfaceResponse.value.data) {
          nextSurface = surfaceResponse.value.data;
        } else {
          setDesktopProviderError(surfaceResponse.value.error?.message || 'Computer Surface state unavailable');
        }
      } else {
        setDesktopProviderError(surfaceResponse.reason instanceof Error ? surfaceResponse.reason.message : String(surfaceResponse.reason));
      }

      if (observeResponse.status === 'fulfilled') {
        const response = observeResponse.value;
        if (response.success && response.data) {
          setObservation(response.data);
          nextSurface = response.data.state || nextSurface;
        } else {
          setObserveError(response.error?.message || 'observeComputerSurface failed');
          if (response.data?.state) {
            nextSurface = response.data.state;
          }
        }
      } else {
        setObserveError(observeResponse.reason instanceof Error ? observeResponse.reason.message : String(observeResponse.reason));
      }
      setSurface(nextSurface);

      if (hasNative) {
        const [capabilitiesResult, permissionsResult, collectorResult, frontmostResult, eventsResult] =
          await Promise.allSettled([
            getNativeDesktopCapabilities(),
            getNativeDesktopPermissionStatus(),
            getNativeDesktopCollectorStatus(),
            getFrontmostDesktopContext(),
            listRecentNativeDesktopEvents(40),
          ]);
        setCapabilities(capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : null);
        setPermissionSnapshot(permissionsResult.status === 'fulfilled' ? permissionsResult.value : null);
        setCollectorStatus(collectorResult.status === 'fulfilled' ? collectorResult.value : null);
        setFrontmost(frontmostResult.status === 'fulfilled' ? frontmostResult.value : null);
        setRecentEvents(eventsResult.status === 'fulfilled' ? eventsResult.value : []);
      } else {
        setCapabilities(null);
        setPermissionSnapshot(null);
        setCollectorStatus(null);
        setFrontmost(null);
        setRecentEvents([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadElements = useCallback(async (targetApp: string | null) => {
    setElementsResult(null);
    setElementsError(null);
    if (!targetApp) {
      return;
    }

    setElementsLoading(true);
    try {
      const response = await listComputerSurfaceElements({
        targetApp,
        limit: 16,
        maxDepth: 4,
      });
      if (response.success && response.data) {
        setElementsResult(response.data);
        if (response.data.state) {
          setSurface(response.data.state);
        }
      } else {
        setElementsError(response.error?.message || 'listComputerSurfaceElements failed');
        if (response.data) {
          setElementsResult(response.data);
          if (response.data.state) {
            setSurface(response.data.state);
          }
        }
      }
    } catch (error) {
      setElementsError(error instanceof Error ? error.message : String(error));
    } finally {
      setElementsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const targets = useMemo(
    () => buildComputerUseTargets({ frontmost, recentEvents, surface }),
    [frontmost, recentEvents, surface],
  );

  useEffect(() => {
    if (targets.length === 0) {
      setSelectedTargetApp(null);
      return;
    }
    if (selectedTargetApp && targets.some((target) => target.appName === selectedTargetApp)) {
      return;
    }
    setSelectedTargetApp(targets[0].appName);
  }, [selectedTargetApp, targets]);

  useEffect(() => {
    void loadElements(selectedTargetApp);
  }, [loadElements, selectedTargetApp]);

  const actionSummary = useMemo(() => buildRecentComputerUseAction(surface), [surface]);
  const elementCandidates = useMemo(() => toElementCandidates(elementsResult), [elementsResult]);
  const screenPermission = getNativePermissionStatus(permissionSnapshot, 'screenCapture');
  const accessibilityPermission = getNativePermissionStatus(permissionSnapshot, 'accessibility');
  const failureExplanations = useMemo(
    () => describeComputerUseFailures({
      nativeAvailable,
      desktopProviderError,
      capabilities,
      permissions: permissionSnapshot,
      surface,
      targets,
      selectedTargetApp,
      elementsError,
      observeError,
    }),
    [
      capabilities,
      desktopProviderError,
      elementsError,
      nativeAvailable,
      observeError,
      permissionSnapshot,
      selectedTargetApp,
      surface,
      targets,
    ],
  );

  const providerTone: StatusTone = desktopProviderError
    ? 'blocked'
    : surface?.ready
      ? 'ready'
      : surface
        ? 'warning'
        : 'neutral';
  const nativeTone: StatusTone = nativeAvailable ? 'ready' : 'warning';
  const axQuality = elementsResult?.metadata?.axQuality && typeof elementsResult.metadata.axQuality === 'object'
    ? elementsResult.metadata.axQuality as { grade?: string; elementCount?: number; reasons?: string[] }
    : surface?.axQuality || null;
  const metadataElementCount = extractMetadataNumber(elementsResult, 'elementCount');

  return (
    <FullScreenPage testId="computer-use-panel">
      <FullScreenPageHeader
        icon={<MousePointerClick className="h-4 w-4 text-cyan-300" />}
        title="Computer Use"
        description="桌面自动化行动前的权限、窗口、AX 证据和控制边界"
        badge={<StatusPill label="诊断" tone="neutral" />}
        onClose={() => setShowComputerUsePanel(false)}
        closeLabel="关闭 Computer Use"
        actions={(
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </button>
        )}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在读取 Computer Surface
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-[300px] shrink-0 border-r border-zinc-800 p-4 overflow-y-auto">
            <div className="space-y-3">
              <BoundaryCard
                icon={<Eye className="h-4 w-4" />}
                title="只读查看"
                detail="当前页会读取 provider、权限、窗口候选、AX candidates 和最近 action trace。"
                tone="ready"
              />
              <BoundaryCard
                icon={<ZapOff className="h-4 w-4" />}
                title="执行动作"
                detail="点击、输入、拖拽、多步 GUI 自动化没有在这个入口开放。真实动作仍走现有 tool permission 和确认链路。"
                tone="warning"
              />
            </div>

            <div className="mt-5 space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Provider</div>
              <div className="space-y-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-200">Native Desktop</span>
                    <StatusPill label={nativeAvailable ? 'Tauri 可用' : 'Web 降级'} tone={nativeTone} />
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {capabilities
                      ? `${capabilities.platform} · ${capabilities.phase}`
                      : '没有 native bridge 时，系统权限和前台窗口只能降级展示。'}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-200">Computer Surface</span>
                    <StatusPill
                      label={surface?.mode || (desktopProviderError ? '不可用' : '未知')}
                      tone={providerTone}
                    />
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {surface?.safetyNote || desktopProviderError || '等待 surface state。'}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-200">Activity Collector</span>
                    <StatusPill
                      label={collectorStatus?.running ? '采集中' : collectorStatus ? '已停止' : '未知'}
                      tone={collectorStatus?.running ? 'ready' : collectorStatus ? 'warning' : 'neutral'}
                    />
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    只作为 app/window 候选来源，不等同于 Computer Use 授权。
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Permissions</div>
              {[
                {
                  label: 'Screen Recording',
                  permission: screenPermission,
                  detail: screenPermission?.detail || '用于截图、窗口标题和视觉证据。',
                },
                {
                  label: 'Accessibility',
                  permission: accessibilityPermission,
                  detail: accessibilityPermission?.detail || '用于 AX tree、后台元素定位和受控桌面动作。',
                },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-200">{item.label}</span>
                    <StatusPill label={permissionLabel(item.permission)} tone={permissionTone(item.permission)} />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">{item.detail}</p>
                </div>
              ))}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">Automation</span>
                  <StatusPill label="按 app 单独授权" tone="warning" />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Apple Events 权限按目标 app 触发，当前 bridge 不提供全局状态；浏览器 URL/title 读取会按目标 app 降级。
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 p-5">
              <div className="space-y-4">
                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <AppWindow className="h-4 w-4 text-cyan-300" />
                      <h3 className="text-sm font-medium text-zinc-200">App / Window 候选</h3>
                    </div>
                    <span className="text-[11px] text-zinc-500">{targets.length} 个候选</span>
                  </div>
                  {targets.length === 0 ? (
                    <div className="p-6 text-sm text-zinc-500">
                      没有拿到 frontmost context、recent activity 或 approved app。Web 模式和无 provider 场景会落到这里。
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-800/80">
                      {targets.map((target) => {
                        const selected = target.appName === selectedTargetApp;
                        return (
                          <button
                            key={target.id}
                            type="button"
                            onClick={() => setSelectedTargetApp(target.appName)}
                            className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                              selected ? 'bg-cyan-500/10' : 'hover:bg-zinc-800/40'
                            }`}
                          >
                            <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                              selected ? 'bg-cyan-500/20 text-cyan-200' : 'bg-zinc-800 text-zinc-500'
                            }`}>
                              <AppWindow className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-sm font-medium text-zinc-200">{target.appName}</span>
                                <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                  {targetSourceLabel(target.source)}
                                </span>
                              </div>
                              <div className="mt-1 truncate text-xs text-zinc-500">
                                {target.windowTitle || target.bundleId || '没有窗口标题'}
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(target.capturedAtMs)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <SquareMousePointer className="h-4 w-4 text-emerald-300" />
                      <h3 className="text-sm font-medium text-zinc-200">AX Tree / 可操作元素</h3>
                    </div>
                    <button
                      type="button"
                      disabled={!selectedTargetApp || elementsLoading}
                      onClick={() => void loadElements(selectedTargetApp)}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                    >
                      {elementsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      重新读取
                    </button>
                  </div>
                  <div className="border-b border-zinc-800/80 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill
                        label={selectedTargetApp || '未选择 app'}
                        tone={selectedTargetApp ? 'neutral' : 'warning'}
                      />
                      {axQuality?.grade && (
                        <StatusPill
                          label={`AX ${axQuality.grade}`}
                          tone={axQuality.grade === 'good' ? 'ready' : axQuality.grade === 'usable' ? 'warning' : 'blocked'}
                        />
                      )}
                      <StatusPill
                        label={`${metadataElementCount ?? elementCandidates.length} elements`}
                        tone={elementCandidates.length > 0 ? 'ready' : elementsError ? 'blocked' : 'neutral'}
                      />
                    </div>
                    {Array.isArray(axQuality?.reasons) && axQuality.reasons.length > 0 && (
                      <p className="mt-2 text-xs text-amber-300">{axQuality.reasons.slice(0, 2).join('；')}</p>
                    )}
                    {elementsError && (
                      <p className="mt-2 text-xs text-rose-300">{elementsError}</p>
                    )}
                  </div>
                  {elementsLoading ? (
                    <div className="flex items-center justify-center p-6 text-sm text-zinc-500">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      正在读取 AX candidates
                    </div>
                  ) : elementCandidates.length === 0 ? (
                    <div className="p-6 text-sm text-zinc-500">
                      没有可展示元素。常见原因是 Accessibility 未授权、目标窗口不可读、Electron/CEF/WKWebView 只暴露容器，或目标 app 当前不在可访问状态。
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-800/80">
                      {elementCandidates.map((candidate) => (
                        <div key={candidate.id} className="grid grid-cols-[120px_minmax(0,1fr)_110px] gap-3 px-4 py-2.5 text-xs">
                          <span className="truncate font-mono text-zinc-500">{candidate.role}</span>
                          <span className="truncate text-zinc-200">{candidate.label}</span>
                          <span className="truncate text-right font-mono text-zinc-600">
                            {candidate.axPath || (candidate.enabled === false ? 'disabled' : 'no axPath')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-amber-300" />
                    <h3 className="text-sm font-medium text-zinc-200">失败原因解释</h3>
                  </div>
                  <div className="grid gap-2 p-4 md:grid-cols-2">
                    {failureExplanations.map((item) => (
                      <div key={item.id} className={`rounded-lg border p-3 ${failureToneClass(item.tone)}`}>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {item.tone === 'blocked' ? <ShieldAlert className="h-4 w-4" /> : <Circle className="h-3.5 w-3.5" />}
                          {item.title}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed opacity-80">{item.detail}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <aside className="space-y-4">
                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    <h3 className="text-sm font-medium text-zinc-200">能力边界</h3>
                  </div>
                  <div className="space-y-2 p-4 text-xs leading-relaxed text-zinc-400">
                    <p>只读：provider 状态、权限、前台窗口、最近活动、AX candidates、最近 action trace。</p>
                    <p>真实可执行：本页只有刷新和读取候选；不触发点击、输入、拖拽、快捷键或跨 app 流程。</p>
                    <p>执行链路：现有 `computer_use` 工具、permission dialog、action preview 和 desktop IPC 继续负责动作。</p>
                  </div>
                </section>

                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <MousePointerClick className="h-4 w-4 text-cyan-300" />
                    <h3 className="text-sm font-medium text-zinc-200">最近一次 Tool Call</h3>
                  </div>
                  {actionSummary?.preview ? (
                    <div className="space-y-3 p-4">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                        <div className="text-sm text-zinc-100">{actionSummary.preview.summary}</div>
                        {actionSummary.preview.target && (
                          <div className="mt-1 truncate text-xs text-zinc-500">{actionSummary.preview.target}</div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <StatusPill label={actionSummary.preview.riskLabel} tone={actionSummary.preview.risk === 'read' ? 'ready' : 'warning'} />
                          <StatusPill label={actionSummary.preview.mode || actionSummary.trace.mode} tone="neutral" />
                          <StatusPill label={actionSummary.preview.scope} tone="neutral" />
                        </div>
                      </div>
                      {actionSummary.resultSummary && (
                        <p className="text-xs text-zinc-400">{actionSummary.resultSummary}</p>
                      )}
                      {actionSummary.trace.failureKind && (
                        <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-2 text-xs text-rose-200">
                          {actionSummary.trace.failureKind}
                        </p>
                      )}
                      {actionSummary.trace.recommendedAction && (
                        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-200">
                          {actionSummary.trace.recommendedAction}
                        </p>
                      )}
                      <div className="truncate text-[11px] text-zinc-600">trace {actionSummary.trace.id}</div>
                    </div>
                  ) : (
                    <div className="p-4 text-sm text-zinc-500">
                      还没有 Computer Surface action trace。执行过 `computer_use.get_state / observe / get_ax_elements` 后会在这里显示风险摘要。
                    </div>
                  )}
                </section>

                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <Lock className="h-4 w-4 text-zinc-400" />
                    <h3 className="text-sm font-medium text-zinc-200">当前窗口观察</h3>
                  </div>
                  <div className="space-y-2 p-4 text-xs text-zinc-400">
                    <div className="flex items-center justify-between gap-3">
                      <span>前台 app</span>
                      <span className="truncate text-zinc-200">{observation?.snapshot?.appName || frontmost?.appName || '未知'}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0">窗口</span>
                      <span className="min-w-0 text-right text-zinc-200">{observation?.snapshot?.windowTitle || frontmost?.windowTitle || '未知'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Surface ready</span>
                      <span className={surface?.ready ? 'text-emerald-300' : 'text-amber-300'}>
                        {surface?.ready ? 'yes' : 'no / unknown'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Approval scope</span>
                      <span className="text-zinc-200">{surface?.approvalScope || 'unknown'}</span>
                    </div>
                    {surface?.evidenceSummary?.slice(0, 3).map((line) => (
                      <div key={line} className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-500">
                        {line}
                      </div>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </div>
        </div>
      )}
    </FullScreenPage>
  );
};
