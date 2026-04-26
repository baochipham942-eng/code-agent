import type {
  ActivityContext,
  ActivityContextItem,
  ActivityContextSource,
  ActivityEvidenceRef,
  AudioSegment,
  DesktopActivityEvent,
} from '@shared/contract';
import { fetchOpenchronicleContext } from '../external/openchronicleContextProvider';
import { getNativeDesktopService } from '../desktop/nativeDesktopService';

const DEFAULT_MAX_CHARS = 12_000;
const OPENCHRONICLE_MAX_CHARS = 3_000;
const NATIVE_DESKTOP_MAX_CHARS = 4_000;
const AUDIO_MAX_CHARS = 3_000;
const SCREENSHOT_ANALYSIS_MAX_CHARS = 2_000;
const RECENT_EVENT_LIMIT = 20;
const AUDIO_LOOKBACK_MS = 60 * 60 * 1000;

interface NativeDesktopActivityReader {
  getCurrentContext(): DesktopActivityEvent | null;
  listRecent(limit?: number): DesktopActivityEvent[];
  listAudioSegments(from: number, to: number): AudioSegment[];
}

export interface BuildActivityContextDeps {
  nowMs?: () => number;
  maxChars?: number;
  openchronicleContextFetcher?: () => Promise<string | null>;
  nativeDesktopService?: NativeDesktopActivityReader;
}

export async function getCurrentActivityContext(): Promise<ActivityContext> {
  return buildActivityContext();
}

export async function buildActivityContext(deps: BuildActivityContextDeps = {}): Promise<ActivityContext> {
  const now = deps.nowMs?.() ?? Date.now();
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const nativeDesktop = deps.nativeDesktopService ?? getNativeDesktopService();

  const openchronicleSource = await buildOpenchronicleSource({
    now,
    fetcher: deps.openchronicleContextFetcher ?? fetchOpenchronicleContext,
  });

  const { nativeDesktopSource, recentEvents } = buildNativeDesktopSource({
    now,
    service: nativeDesktop,
  });

  const audioSource = buildAudioSource({
    now,
    service: nativeDesktop,
  });

  const screenshotAnalysisSource = buildScreenshotAnalysisSource({
    now,
    recentEvents,
  });

  const sources = [
    openchronicleSource,
    nativeDesktopSource,
    audioSource,
    screenshotAnalysisSource,
  ];

  return {
    generatedAtMs: now,
    maxChars,
    tokenBudgetHint: {
      maxChars,
      targetTokens: Math.ceil(maxChars / 4),
    },
    sources,
    evidenceRefs: sources.flatMap((source) => source.evidenceRefs),
  };
}

async function buildOpenchronicleSource(args: {
  now: number;
  fetcher: () => Promise<string | null>;
}): Promise<ActivityContextSource> {
  try {
    const text = await args.fetcher();
    if (!text?.trim()) {
      return unavailableSource('openchronicle', args.now, OPENCHRONICLE_MAX_CHARS, 'OpenChronicle context is empty or disabled');
    }

    const evidenceRef: ActivityEvidenceRef = {
      source: 'openchronicle',
      kind: 'openchronicle-context',
      id: `openchronicle:${args.now}`,
      label: 'OpenChronicle current_context',
      capturedAtMs: args.now,
    };

    return {
      source: 'openchronicle',
      status: 'available',
      confidence: 0.72,
      privacy: 'redacted',
      generatedAtMs: args.now,
      maxChars: OPENCHRONICLE_MAX_CHARS,
      text: trimToMaxChars(text, OPENCHRONICLE_MAX_CHARS),
      evidenceRefs: [evidenceRef],
    };
  } catch (error) {
    return unavailableSource(
      'openchronicle',
      args.now,
      OPENCHRONICLE_MAX_CHARS,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function buildNativeDesktopSource(args: {
  now: number;
  service: NativeDesktopActivityReader;
}): { nativeDesktopSource: ActivityContextSource; recentEvents: DesktopActivityEvent[] } {
  try {
    const current = args.service.getCurrentContext();
    const recentEvents = args.service.listRecent(RECENT_EVENT_LIMIT);
    const uniqueEvents = uniqueDesktopEvents([current, ...recentEvents].filter(Boolean) as DesktopActivityEvent[]);
    const items = uniqueEvents.map(toDesktopActivityItem);
    const evidenceRefs = items.flatMap((item) => item.evidenceRefs ?? []);

    if (items.length === 0) {
      return {
        nativeDesktopSource: unavailableSource('tauri-native-desktop', args.now, NATIVE_DESKTOP_MAX_CHARS, 'No native desktop activity events available'),
        recentEvents,
      };
    }

    return {
      nativeDesktopSource: {
        source: 'tauri-native-desktop',
        status: 'available',
        confidence: current ? 0.82 : 0.64,
        privacy: 'local-only',
        generatedAtMs: args.now,
        maxChars: NATIVE_DESKTOP_MAX_CHARS,
        text: trimToMaxChars(items.map(formatDesktopItem).filter(Boolean).join('\n'), NATIVE_DESKTOP_MAX_CHARS),
        items,
        evidenceRefs,
      },
      recentEvents,
    };
  } catch (error) {
    return {
      nativeDesktopSource: unavailableSource(
        'tauri-native-desktop',
        args.now,
        NATIVE_DESKTOP_MAX_CHARS,
        error instanceof Error ? error.message : String(error),
      ),
      recentEvents: [],
    };
  }
}

function buildAudioSource(args: {
  now: number;
  service: NativeDesktopActivityReader;
}): ActivityContextSource {
  try {
    const from = args.now - AUDIO_LOOKBACK_MS;
    const segments = args.service.listAudioSegments(from, args.now);
    const items = segments.map(toAudioItem);
    const evidenceRefs = items.flatMap((item) => item.evidenceRefs ?? []);

    if (items.length === 0) {
      return unavailableSource('audio', args.now, AUDIO_MAX_CHARS, 'No audio segments found in the last hour');
    }

    return {
      source: 'audio',
      status: 'available',
      confidence: 0.68,
      privacy: 'local-only',
      generatedAtMs: args.now,
      maxChars: AUDIO_MAX_CHARS,
      text: trimToMaxChars(items.map(formatAudioItem).filter(Boolean).join('\n'), AUDIO_MAX_CHARS),
      items,
      evidenceRefs,
    };
  } catch (error) {
    return unavailableSource(
      'audio',
      args.now,
      AUDIO_MAX_CHARS,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function buildScreenshotAnalysisSource(args: {
  now: number;
  recentEvents: DesktopActivityEvent[];
}): ActivityContextSource {
  const screenshotEvents = args.recentEvents.filter((event) => event.screenshotPath || event.analyzeText?.trim());
  const items = screenshotEvents.map(toScreenshotAnalysisItem);
  const evidenceRefs = items.flatMap((item) => item.evidenceRefs ?? []);

  if (items.length === 0) {
    return unavailableSource('screenshot-analysis', args.now, SCREENSHOT_ANALYSIS_MAX_CHARS, 'No recent screenshot analysis available');
  }

  const analyzedCount = screenshotEvents.filter((event) => Boolean(event.analyzeText?.trim())).length;

  return {
    source: 'screenshot-analysis',
    status: 'available',
    confidence: analyzedCount > 0 ? 0.74 : 0.42,
    privacy: 'local-only',
    generatedAtMs: args.now,
    maxChars: SCREENSHOT_ANALYSIS_MAX_CHARS,
    text: trimToMaxChars(items.map(formatScreenshotItem).filter(Boolean).join('\n'), SCREENSHOT_ANALYSIS_MAX_CHARS),
    items,
    evidenceRefs,
  };
}

function toDesktopActivityItem(event: DesktopActivityEvent): ActivityContextItem {
  const evidenceRef: ActivityEvidenceRef = {
    source: 'tauri-native-desktop',
    kind: 'desktop-event',
    id: event.id,
    label: event.windowTitle || event.browserTitle || event.appName,
    capturedAtMs: event.capturedAtMs,
  };

  return {
    id: event.id,
    title: event.windowTitle || event.browserTitle || event.appName,
    appName: event.appName,
    windowTitle: event.windowTitle,
    browserUrl: event.browserUrl,
    screenshotPath: event.screenshotPath,
    capturedAtMs: event.capturedAtMs,
    confidence: 0.8,
    evidenceRefs: [evidenceRef],
    raw: event,
  };
}

function toAudioItem(segment: AudioSegment): ActivityContextItem {
  const evidenceRef: ActivityEvidenceRef = {
    source: 'audio',
    kind: 'audio-segment',
    id: segment.id,
    label: segment.transcript,
    path: segment.wav_path,
    startAtMs: segment.start_at_ms,
    endAtMs: segment.end_at_ms,
  };

  return {
    id: segment.id,
    text: segment.transcript,
    startAtMs: segment.start_at_ms,
    endAtMs: segment.end_at_ms,
    confidence: 0.62,
    evidenceRefs: [evidenceRef],
    raw: segment,
  };
}

function toScreenshotAnalysisItem(event: DesktopActivityEvent): ActivityContextItem {
  const evidenceRef: ActivityEvidenceRef = {
    source: 'screenshot-analysis',
    kind: 'screenshot-analysis',
    id: event.id,
    label: event.analyzeText || event.windowTitle || event.appName,
    path: event.screenshotPath,
    capturedAtMs: event.capturedAtMs,
  };

  return {
    id: event.id,
    title: event.windowTitle || event.browserTitle || event.appName,
    text: event.analyzeText || null,
    appName: event.appName,
    windowTitle: event.windowTitle,
    screenshotPath: event.screenshotPath,
    capturedAtMs: event.capturedAtMs,
    confidence: event.analyzeText?.trim() ? 0.74 : 0.42,
    evidenceRefs: [evidenceRef],
    raw: event,
  };
}

function unavailableSource(
  source: ActivityContextSource['source'],
  generatedAtMs: number,
  maxChars: number,
  unavailableReason: string,
): ActivityContextSource {
  return {
    source,
    status: 'unavailable',
    confidence: 0,
    privacy: source === 'openchronicle' ? 'redacted' : 'local-only',
    generatedAtMs,
    maxChars,
    text: null,
    items: [],
    evidenceRefs: [],
    unavailableReason,
  };
}

function uniqueDesktopEvents(events: DesktopActivityEvent[]): DesktopActivityEvent[] {
  const seen = new Set<string>();
  const unique: DesktopActivityEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function formatDesktopItem(item: ActivityContextItem): string {
  const parts = [
    item.appName,
    item.windowTitle,
    item.browserUrl,
  ].filter(Boolean);
  return parts.join(' | ');
}

function formatAudioItem(item: ActivityContextItem): string {
  if (!item.text) return '';
  return `[${item.startAtMs ?? ''}-${item.endAtMs ?? ''}] ${item.text}`;
}

function formatScreenshotItem(item: ActivityContextItem): string {
  const title = [item.appName, item.windowTitle].filter(Boolean).join(' | ');
  const text = item.text || (item.screenshotPath ? `Screenshot: ${item.screenshotPath}` : '');
  return [title, text].filter(Boolean).join('\n');
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 12))}\n...(truncated)`;
}
