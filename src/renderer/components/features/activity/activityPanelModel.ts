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
import type { activityPanelZh } from '../../../i18n/activity';

export type ActivityPanelMode = 'tauri' | 'web' | 'desktop';
export type ActivityTone = 'ready' | 'idle' | 'blocked';

/** Activity 面板词条（t.activityPanel）。zh/en 成对，见 i18n/activity.ts。 */
export type ActivityPanelCopy = typeof activityPanelZh.activityPanel;

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

const SOURCE_KIND_TO_COPY_KEY = {
  openchronicle: 'openchronicle',
  'tauri-native-desktop': 'tauriNativeDesktop',
  audio: 'audio',
  'screenshot-analysis': 'screenshotAnalysis',
} as const;

const SOURCE_ORDER: ActivityContextSourceKind[] = [
  'openchronicle',
  'tauri-native-desktop',
  'audio',
  'screenshot-analysis',
];

function compactText(value: string | null | undefined, maxChars = 140): string {
  const normalized = redactActivityEvidence(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatTime(ms: number | null | undefined, locale: string): string {
  if (!ms || !Number.isFinite(ms)) return '--:--';
  return new Intl.DateTimeFormat(locale, {
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

function injectionDetailForSource(source: ActivityContextSource, copy: ActivityPanelCopy): string {
  if (source.source === 'openchronicle') {
    return copy.injection.screenMemoryDetail.replace('{maxChars}', String(source.maxChars));
  }
  return copy.injection.desktopActivityDetail.replace('{maxChars}', String(source.maxChars));
}

function buildModeCopy(mode: ActivityPanelMode, shellLabel: string, copy: ActivityPanelCopy): Pick<ActivityPanelModel, 'modeLabel' | 'modeDetail' | 'modeTone'> {
  if (mode === 'tauri') {
    return {
      modeLabel: copy.modes.tauriLabel,
      modeDetail: copy.modes.tauriDetail,
      modeTone: 'ready',
    };
  }
  if (mode === 'web') {
    return {
      modeLabel: copy.modes.webLabel,
      modeDetail: copy.modes.webDetail,
      modeTone: 'blocked',
    };
  }
  return {
    modeLabel: shellLabel || copy.modes.desktopLabelFallback,
    modeDetail: copy.modes.desktopDetail,
    modeTone: 'idle',
  };
}

function buildRecentSummary(args: {
  preview: ActivityContextPreview;
  native: ActivityNativeSnapshot;
  copy: ActivityPanelCopy;
}): Pick<ActivityPanelModel, 'recentHeadline' | 'recentDetail' | 'recentItems'> {
  const { copy } = args;
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
      recentHeadline: copy.recent.headline
        .replace('{count}', String(events.length))
        .replace('{app}', events[0]?.appName || copy.recent.unknownApp),
      recentDetail: [
        topApps.length ? copy.recent.topApps.replace('{apps}', topApps.join(' / ')) : '',
        screenshotCount > 0 ? copy.recent.screenshotEvidence.replace('{count}', String(screenshotCount)) : '',
        analyzedCount > 0 ? copy.recent.analyzed.replace('{count}', String(analyzedCount)) : '',
      ].filter(Boolean).join(' · ') || copy.recent.noMoreSummary,
      recentItems: events.slice(0, 5).map((event) => ({
        key: event.id,
        timeLabel: formatTime(event.capturedAtMs, copy.dateLocale),
        title: compactText(event.windowTitle || event.browserTitle || event.appName, 90) || event.appName,
        detail: compactText(
          [
            event.appName,
            event.browserUrl,
            event.analyzeText ? copy.recent.hasAnalysis : '',
            event.screenshotPath ? copy.recent.hasScreenshot : '',
          ].filter(Boolean).join(' · '),
          130,
        ),
      })),
    };
  }

  const contextSummary = compactText(args.preview.recentContextSummary, 220);
  if (contextSummary && contextSummary !== copy.emptyPreview.summary) {
    return {
      recentHeadline: contextSummary,
      recentDetail: copy.recent.contextSummaryDetail,
      recentItems: [],
    };
  }

  return {
    recentHeadline: copy.recent.emptyHeadline,
    recentDetail: copy.recent.emptyDetail,
    recentItems: [],
  };
}

function buildCapabilityRows(args: {
  providers: ActivityProviderDescriptor[];
  context?: ActivityContext | null;
  native: ActivityNativeSnapshot;
  copy: ActivityPanelCopy;
}): ActivityCapabilityRow[] {
  const { copy } = args;
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
      value: availableSourceCount > 0
        ? copy.capability.sourcesAvailable.replace('{count}', String(availableSourceCount))
        : copy.capability.noContext,
      detail: args.context
        ? copy.capability.tokenBudget
          .replace('{tokens}', String(args.context.tokenBudgetHint.targetTokens))
          .replace('{count}', String(args.context.evidenceRefs.length))
        : copy.capability.contextNotReturned,
      tone: availableSourceCount > 0 ? 'ready' : 'idle',
    },
    {
      key: 'openchronicle',
      label: copy.sources.openchronicle,
      value: openchronicle ? copy.providerStates[openchronicle.state] : copy.provider.stateNotReturned,
      detail: openchronicle?.summary || sources.get('openchronicle')?.unavailableReason || copy.capability.openchronicleFallback,
      tone: providerStateTone(openchronicle?.state) || sourceTone(sources.get('openchronicle')),
    },
    {
      key: 'native-desktop',
      label: copy.sources.tauriNativeDesktop,
      value: nativeProvider
        ? copy.providerStates[nativeProvider.state]
        : copy.capability.nativeRecords.replace('{count}', String(args.native.recentEvents.length)),
      detail: nativeProvider?.summary || sources.get('tauri-native-desktop')?.unavailableReason || copy.capability.nativeFallback,
      tone: nativeProvider ? providerStateTone(nativeProvider.state) : args.native.recentEvents.length > 0 ? 'ready' : 'idle',
    },
    {
      key: 'screenshot-analysis',
      label: copy.sources.screenshotAnalysis,
      value: screenshotSource?.status === 'available' || analyzedEvents > 0 ? copy.capability.available : copy.capability.noAnalysis,
      detail: analyzedEvents > 0
        ? copy.capability.analysisSummary
          .replace('{analyzed}', String(analyzedEvents))
          .replace('{screenshots}', String(screenshotEvents))
        : screenshotSource?.unavailableReason || copy.capability.screenshotFallback,
      tone: screenshotSource?.status === 'available' || analyzedEvents > 0 ? 'ready' : 'idle',
    },
    {
      key: 'audio',
      label: copy.sources.audio,
      value: audioSource?.status === 'available' || args.native.audioSegments.length > 0 || args.native.audioStatus?.capturing
        ? copy.capability.available
        : copy.capability.noMeetingContext,
      detail: args.native.audioStatus?.capturing
        ? copy.capability.recording
          .replace('{count}', String(args.native.audioStatus.totalSegments))
          .replace('{mode}', args.native.audioStatus.captureMode === 'system-audio' ? copy.capability.modeSystemAudio : copy.capability.modeMicrophone)
        : args.native.audioSegments.length > 0
          ? copy.capability.transcriptSegments.replace('{count}', String(args.native.audioSegments.length))
          : audioSource?.unavailableReason || copy.capability.audioFallback,
      tone: audioSource?.status === 'available' || args.native.audioSegments.length > 0 || args.native.audioStatus?.capturing ? 'ready' : 'idle',
    },
  ];
}

function buildInjectionItems(context: ActivityContext | null | undefined, copy: ActivityPanelCopy): ActivityPromptBoundaryItem[] {
  const sources = sourceMap(context);
  const items = SOURCE_ORDER
    .map((kind) => sources.get(kind))
    .filter((source): source is ActivityContextSource => Boolean(source))
    .filter(sourceHasPromptText)
    .map((source) => ({
      key: `inject:${source.source}`,
      label: copy.sources[SOURCE_KIND_TO_COPY_KEY[source.source]],
      detail: injectionDetailForSource(source, copy),
      tone: 'ready' as const,
    }));

  if (items.length > 0) return items;
  return [{
    key: 'inject:empty',
    label: copy.injection.emptyLabel,
    detail: copy.injection.emptyDetail,
    tone: 'idle',
  }];
}

function buildLocalEvidenceItems(args: {
  context?: ActivityContext | null;
  native: ActivityNativeSnapshot;
  copy: ActivityPanelCopy;
}): ActivityPromptBoundaryItem[] {
  const { copy } = args;
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
      label: copy.localEvidence.evidenceLabel,
      detail: [
        evidenceCount > 0 ? copy.localEvidence.evidenceRefs.replace('{count}', String(evidenceCount)) : '',
        screenshotCount > 0 ? copy.localEvidence.screenshotsLocal.replace('{count}', String(screenshotCount)) : '',
        audioPathCount > 0 ? copy.localEvidence.audioPaths.replace('{count}', String(audioPathCount)) : '',
      ].filter(Boolean).join(' · '),
      tone: 'ready',
    });
  }

  for (const source of unavailableSources) {
    items.push({
      key: `local:${source.source}`,
      label: copy.sources[SOURCE_KIND_TO_COPY_KEY[source.source]],
      detail: compactText(source.unavailableReason, 150) || copy.localEvidence.sourceUnavailableFallback,
      tone: 'idle',
    });
  }

  if (items.length > 0) return items;
  return [{
    key: 'local:empty',
    label: copy.localEvidence.emptyLabel,
    detail: copy.localEvidence.emptyDetail,
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
  copy: ActivityPanelCopy;
}): ActivityPanelModel {
  return {
    ...buildModeCopy(args.mode, args.shellLabel, args.copy),
    ...buildRecentSummary({ preview: args.preview, native: args.native, copy: args.copy }),
    capabilityRows: buildCapabilityRows({
      providers: args.providers,
      context: args.context,
      native: args.native,
      copy: args.copy,
    }),
    injectionItems: buildInjectionItems(args.context, args.copy),
    localEvidenceItems: buildLocalEvidenceItems({
      context: args.context,
      native: args.native,
      copy: args.copy,
    }),
  };
}

export function getActivitySourceLabel(kind: ActivityContextSourceKind, copy: ActivityPanelCopy): string {
  return copy.sources[SOURCE_KIND_TO_COPY_KEY[kind]];
}

export function getActivitySourceItemCount(source?: ActivityContextSource | null): number {
  return sourceItemCount(source);
}
