import type {
  ActivityContext,
  ActivityContextSource,
  ActivityContextSourceKind,
} from '@shared/contract/activityContext';
import type {
  ActivityProviderDescriptor,
  ActivityProviderState,
} from '@shared/contract/activityProvider';
import type {
  AudioCaptureStatus,
  AudioSegment,
  DesktopActivityEvent,
  NativeDesktopCollectorStatus,
} from '../../../services/nativeDesktop';
import type { ActivityContextPreview } from '../../../services/activityContext';
import { redactActivityEvidence } from '../../../services/activityContext';

export type ActivityPanelMode = 'tauri' | 'web' | 'desktop';
export type ActivityTone = 'ready' | 'idle' | 'blocked';

export interface ActivityNativeSnapshot {
  collectorStatus?: NativeDesktopCollectorStatus | null;
  recentEvents: DesktopActivityEvent[];
  audioStatus?: AudioCaptureStatus | null;
  audioSegments: AudioSegment[];
  error?: string | null;
}

export interface ActivityCapabilityRow {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: ActivityTone;
}

export interface ActivityPromptBoundaryItem {
  key: string;
  label: string;
  detail: string;
  tone: ActivityTone;
}

export interface ActivityRecentItem {
  key: string;
  timeLabel: string;
  title: string;
  detail: string;
}

export interface ActivityPanelModel {
  modeLabel: string;
  modeDetail: string;
  modeTone: ActivityTone;
  recentHeadline: string;
  recentDetail: string;
  recentItems: ActivityRecentItem[];
  capabilityRows: ActivityCapabilityRow[];
  injectionItems: ActivityPromptBoundaryItem[];
  localEvidenceItems: ActivityPromptBoundaryItem[];
}

const SOURCE_LABELS: Record<ActivityContextSourceKind, string> = {
  openchronicle: '自动屏幕记忆',
  'tauri-native-desktop': '桌面活动',
  audio: '音频/会议',
  'screenshot-analysis': '截图分析',
};

const PROVIDER_STATE_LABELS: Record<ActivityProviderState, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  available: '可用',
  unavailable: '不可用',
  error: '异常',
};

const SOURCE_ORDER: ActivityContextSourceKind[] = [
  'openchronicle',
  'tauri-native-desktop',
  'audio',
  'screenshot-analysis',
];

const EMPTY_CONTEXT_SUMMARY = '暂无可用屏幕上下文。';

function compactText(value: string | null | undefined, maxChars = 140): string {
  const normalized = redactActivityEvidence(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatTime(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function providerStateTone(state?: ActivityProviderState | null): ActivityTone {
  if (state === 'running' || state === 'available') return 'ready';
  if (state === 'error' || state === 'unavailable') return 'blocked';
  return 'idle';
}

function sourceTone(source?: ActivityContextSource | null): ActivityTone {
  if (!source) return 'idle';
  return source.status === 'available' ? 'ready' : 'blocked';
}

function sourceMap(context?: ActivityContext | null): Map<ActivityContextSourceKind, ActivityContextSource> {
  return new Map((context?.sources ?? []).map((source) => [source.source, source]));
}

function providerMap(providers: ActivityProviderDescriptor[]): Map<string, ActivityProviderDescriptor> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

function sourceHasPromptText(source?: ActivityContextSource | null): boolean {
  return Boolean(source?.status === 'available' && source.text?.trim());
}

function sourceItemCount(source?: ActivityContextSource | null): number {
  return source?.items?.length ?? 0;
}

function injectionDetailForSource(source: ActivityContextSource): string {
  if (source.source === 'openchronicle') {
    return `进入 <screen-memory>，${source.maxChars} chars 上限，作为后台屏幕记忆。`;
  }
  return `非简单任务会进入 <desktop-activity-context>，${source.maxChars} chars 上限。`;
}

function buildModeCopy(mode: ActivityPanelMode, shellLabel: string): Pick<ActivityPanelModel, 'modeLabel' | 'modeDetail' | 'modeTone'> {
  if (mode === 'tauri') {
    return {
      modeLabel: 'Tauri 桌面版',
      modeDetail: '可以读取 ActivityContext、provider 状态，以及本机桌面事件/截图/音频的实时摘要。',
      modeTone: 'ready',
    };
  }
  if (mode === 'web') {
    return {
      modeLabel: 'Web 降级',
      modeDetail: '只展示后端返回的 ActivityContext；Tauri 本机事件、截图和音频实时状态不会直接读取。',
      modeTone: 'blocked',
    };
  }
  return {
    modeLabel: shellLabel || '桌面版',
    modeDetail: '可以展示 Activity provider 与 prompt 预览；Tauri Native Desktop 的本机事件读取不可用。',
    modeTone: 'idle',
  };
}

function buildRecentSummary(args: {
  preview: ActivityContextPreview;
  native: ActivityNativeSnapshot;
}): Pick<ActivityPanelModel, 'recentHeadline' | 'recentDetail' | 'recentItems'> {
  const events = [...args.native.recentEvents].sort((a, b) => b.capturedAtMs - a.capturedAtMs);
  if (events.length > 0) {
    const appCounts = new Map<string, number>();
    for (const event of events) {
      appCounts.set(event.appName, (appCounts.get(event.appName) ?? 0) + 1);
    }
    const topApps = [...appCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([app, count]) => `${app} ${count}`);
    const analyzedCount = events.filter((event) => event.analyzeText?.trim()).length;
    const screenshotCount = events.filter((event) => event.screenshotPath).length;

    return {
      recentHeadline: `最近 ${events.length} 条桌面活动，最新在 ${events[0]?.appName || '未知应用'}。`,
      recentDetail: [
        topApps.length ? `高频应用：${topApps.join(' / ')}` : '',
        screenshotCount > 0 ? `${screenshotCount} 张截图证据` : '',
        analyzedCount > 0 ? `${analyzedCount} 条截图分析` : '',
      ].filter(Boolean).join(' · ') || '已有桌面事件，但还没有更多摘要。',
      recentItems: events.slice(0, 5).map((event) => ({
        key: event.id,
        timeLabel: formatTime(event.capturedAtMs),
        title: compactText(event.windowTitle || event.browserTitle || event.appName, 90) || event.appName,
        detail: compactText(
          [
            event.appName,
            event.browserUrl,
            event.analyzeText ? '有截图分析' : '',
            event.screenshotPath ? '有截图证据' : '',
          ].filter(Boolean).join(' · '),
          130,
        ),
      })),
    };
  }

  const contextSummary = compactText(args.preview.recentContextSummary, 220);
  if (contextSummary && contextSummary !== EMPTY_CONTEXT_SUMMARY) {
    return {
      recentHeadline: contextSummary,
      recentDetail: '当前没有可直接读取的 Tauri 本机事件列表，先展示 ActivityContext 汇总。',
      recentItems: [],
    };
  }

  return {
    recentHeadline: '还没有可展示的近期活动。',
    recentDetail: '没有 provider 数据时这里保持可读空态，不把页面留成空白。',
    recentItems: [],
  };
}

function buildCapabilityRows(args: {
  providers: ActivityProviderDescriptor[];
  context?: ActivityContext | null;
  native: ActivityNativeSnapshot;
}): ActivityCapabilityRow[] {
  const sources = sourceMap(args.context);
  const providers = providerMap(args.providers);
  const openchronicle = providers.get('openchronicle');
  const nativeProvider = providers.get('tauri-native-desktop');
  const availableSourceCount = SOURCE_ORDER.filter((kind) => sources.get(kind)?.status === 'available').length;
  const screenshotSource = sources.get('screenshot-analysis');
  const audioSource = sources.get('audio');
  const analyzedEvents = args.native.recentEvents.filter((event) => event.analyzeText?.trim()).length;
  const screenshotEvents = args.native.recentEvents.filter((event) => event.screenshotPath).length;

  return [
    {
      key: 'activity-context',
      label: 'ActivityContext',
      value: availableSourceCount > 0 ? `${availableSourceCount} 个来源可用` : '暂无上下文',
      detail: args.context
        ? `token 预算约 ${args.context.tokenBudgetHint.targetTokens}，证据 ${args.context.evidenceRefs.length} 条。`
        : '后端还没有返回统一上下文。',
      tone: availableSourceCount > 0 ? 'ready' : 'idle',
    },
    {
      key: 'openchronicle',
      label: '自动屏幕记忆',
      value: openchronicle ? PROVIDER_STATE_LABELS[openchronicle.state] : '未返回 provider',
      detail: openchronicle?.summary || sources.get('openchronicle')?.unavailableReason || '可由 OpenChronicle provider 提供后台记忆。',
      tone: providerStateTone(openchronicle?.state) || sourceTone(sources.get('openchronicle')),
    },
    {
      key: 'native-desktop',
      label: '桌面活动',
      value: nativeProvider ? PROVIDER_STATE_LABELS[nativeProvider.state] : `${args.native.recentEvents.length} 条本机记录`,
      detail: nativeProvider?.summary || sources.get('tauri-native-desktop')?.unavailableReason || 'Tauri 模式可读取最近桌面活动。',
      tone: nativeProvider ? providerStateTone(nativeProvider.state) : args.native.recentEvents.length > 0 ? 'ready' : 'idle',
    },
    {
      key: 'screenshot-analysis',
      label: '截图分析',
      value: screenshotSource?.status === 'available' || analyzedEvents > 0 ? '可用' : '暂无分析',
      detail: analyzedEvents > 0
        ? `${analyzedEvents} 条分析，${screenshotEvents} 张截图证据只留在本地。`
        : screenshotSource?.unavailableReason || '有截图但没有分析时，只作为本地证据展示。',
      tone: screenshotSource?.status === 'available' || analyzedEvents > 0 ? 'ready' : 'idle',
    },
    {
      key: 'audio',
      label: '音频/会议',
      value: audioSource?.status === 'available' || args.native.audioSegments.length > 0 || args.native.audioStatus?.capturing
        ? '可用'
        : '暂无会议上下文',
      detail: args.native.audioStatus?.capturing
        ? `录音中，${args.native.audioStatus.totalSegments} 段，${args.native.audioStatus.captureMode === 'system-audio' ? '系统音频' : '麦克风'}。`
        : args.native.audioSegments.length > 0
          ? `${args.native.audioSegments.length} 段最近转录可作为上下文。`
          : audioSource?.unavailableReason || '录音和会议转录保持显式可见，不自动启动采集。',
      tone: audioSource?.status === 'available' || args.native.audioSegments.length > 0 || args.native.audioStatus?.capturing ? 'ready' : 'idle',
    },
  ];
}

function buildInjectionItems(context?: ActivityContext | null): ActivityPromptBoundaryItem[] {
  const sources = sourceMap(context);
  const items = SOURCE_ORDER
    .map((kind) => sources.get(kind))
    .filter((source): source is ActivityContextSource => Boolean(source))
    .filter(sourceHasPromptText)
    .map((source) => ({
      key: `inject:${source.source}`,
      label: SOURCE_LABELS[source.source],
      detail: injectionDetailForSource(source),
      tone: 'ready' as const,
    }));

  if (items.length > 0) return items;
  return [{
    key: 'inject:empty',
    label: '暂无可注入内容',
    detail: '当前 ActivityContext 没有可进入 prompt 的文本块。',
    tone: 'idle',
  }];
}

function buildLocalEvidenceItems(args: {
  context?: ActivityContext | null;
  native: ActivityNativeSnapshot;
}): ActivityPromptBoundaryItem[] {
  const sources = sourceMap(args.context);
  const evidenceCount = args.context?.evidenceRefs.length ?? 0;
  const screenshotCount = args.native.recentEvents.filter((event) => event.screenshotPath).length;
  const audioPathCount = args.native.audioSegments.filter((segment) => segment.wav_path).length;
  const unavailableSources = SOURCE_ORDER
    .map((kind) => sources.get(kind))
    .filter((source): source is ActivityContextSource => source?.status === 'unavailable');
  const items: ActivityPromptBoundaryItem[] = [];

  if (evidenceCount > 0 || screenshotCount > 0 || audioPathCount > 0) {
    items.push({
      key: 'local:evidence',
      label: '本地证据',
      detail: [
        evidenceCount > 0 ? `${evidenceCount} 条 evidence ref` : '',
        screenshotCount > 0 ? `${screenshotCount} 张截图文件只作本地证据` : '',
        audioPathCount > 0 ? `${audioPathCount} 个音频文件路径不直接展开` : '',
      ].filter(Boolean).join(' · '),
      tone: 'ready',
    });
  }

  for (const source of unavailableSources) {
    items.push({
      key: `local:${source.source}`,
      label: SOURCE_LABELS[source.source],
      detail: compactText(source.unavailableReason, 150) || '该来源当前没有可注入内容，只保留状态说明。',
      tone: 'idle',
    });
  }

  if (items.length > 0) return items;
  return [{
    key: 'local:empty',
    label: '暂无本地证据',
    detail: '没有截图、音频路径或 evidence ref；页面仍保留 provider 与降级说明。',
    tone: 'idle',
  }];
}

export function buildActivityPanelModel(args: {
  mode: ActivityPanelMode;
  shellLabel: string;
  providers: ActivityProviderDescriptor[];
  context?: ActivityContext | null;
  preview: ActivityContextPreview;
  native: ActivityNativeSnapshot;
}): ActivityPanelModel {
  return {
    ...buildModeCopy(args.mode, args.shellLabel),
    ...buildRecentSummary({ preview: args.preview, native: args.native }),
    capabilityRows: buildCapabilityRows({
      providers: args.providers,
      context: args.context,
      native: args.native,
    }),
    injectionItems: buildInjectionItems(args.context),
    localEvidenceItems: buildLocalEvidenceItems({
      context: args.context,
      native: args.native,
    }),
  };
}

export function getActivitySourceLabel(kind: ActivityContextSourceKind): string {
  return SOURCE_LABELS[kind];
}

export function getActivitySourceItemCount(source?: ActivityContextSource | null): number {
  return sourceItemCount(source);
}
