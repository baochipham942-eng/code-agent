// ============================================================================
// Activity Prompt Formatter
// ============================================================================
//
// Pure prompt assembly helpers for future ActivityContextProvider integration.
// This does not inject system messages by itself; callers decide the wrapper tag.
// ============================================================================

export type ActivityPromptMode = 'legacySeparate' | 'unified';

export type ActivityContextSource =
  | 'automatic-background'
  | 'manual-session'
  | 'meeting-audio'
  | 'screenshot-analysis';

export interface ActivityEvidenceRef {
  id?: string | null;
  label?: string | null;
  path?: string | null;
  url?: string | null;
  source?: string | null;
  kind?: string | null;
}

export interface ActivityContextEntry {
  source?: ActivityContextSource | string | null;
  confidence?: number | null;
  timestamp?: string | number | Date | null;
  title?: string | null;
  appName?: string | null;
  app_name?: string | null;
  windowTitle?: string | null;
  window_title?: string | null;
  url?: string | null;
  browserUrl?: string | null;
  summary?: string | null;
  text?: string | null;
  content?: string | null;
  evidenceRefs?: Array<string | ActivityEvidenceRef> | null;
  evidence?: Array<string | ActivityEvidenceRef> | null;
  channel?: 'screen-memory' | 'desktop-activity' | 'activity-context' | string | null;
  contextType?: 'screen-memory' | 'desktop-activity' | 'activity-context' | string | null;
  kind?: string | null;
  capturedAtMs?: number | null;
  startAtMs?: number | null;
  endAtMs?: number | null;
}

export interface ActivityContextLike {
  entries?: ActivityContextEntry[] | null;
  items?: ActivityContextEntry[] | null;
  events?: ActivityContextEntry[] | null;
  sources?: Array<{
    source?: string | null;
    status?: string | null;
    confidence?: number | null;
    text?: string | null;
    items?: ActivityContextEntry[] | null;
    evidenceRefs?: Array<string | ActivityEvidenceRef> | null;
  }> | null;
  screenMemory?: ActivityContextEntry[] | string | null;
  screenMemoryBlock?: string | null;
  desktopActivity?: ActivityContextEntry[] | string | null;
  desktopActivityBlock?: string | null;
  summary?: string | null;
  evidenceRefs?: Array<string | ActivityEvidenceRef> | null;
  source?: ActivityContextSource | string | null;
  confidence?: number | null;
}

export interface ActivityPromptFormatterOptions {
  mode: ActivityPromptMode;
  maxChars?: number;
  maxEvidenceRefsPerEntry?: number;
}

export interface LegacyActivityPromptBlocks {
  mode: 'legacySeparate';
  screenMemoryBlock: string | null;
  desktopActivityBlock: string | null;
}

export interface UnifiedActivityPromptBlock {
  mode: 'unified';
  activityContextBlock: string | null;
}

export type ActivityPromptFormatResult = LegacyActivityPromptBlocks | UnifiedActivityPromptBlock;

const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_MAX_EVIDENCE_REFS = 3;
const MANUAL_SOURCE_BONUS = 2;

const VALID_SOURCES = new Set<ActivityContextSource>([
  'automatic-background',
  'manual-session',
  'meeting-audio',
  'screenshot-analysis',
]);

interface NormalizedActivityEntry {
  source: ActivityContextSource;
  confidence: number;
  text: string;
  title?: string;
  appName?: string;
  windowTitle?: string;
  url?: string;
  timestamp?: string;
  evidenceRefs: string[];
  target: 'screen' | 'desktop' | 'activity';
  originalIndex: number;
}

export function formatActivityPromptContext(
  context: ActivityContextLike | ActivityContextEntry[] | string | null | undefined,
  options: ActivityPromptFormatterOptions,
): ActivityPromptFormatResult {
  const maxChars = Math.max(120, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxEvidenceRefs = Math.max(0, options.maxEvidenceRefsPerEntry ?? DEFAULT_MAX_EVIDENCE_REFS);
  const entries = normalizeContext(context);

  if (options.mode === 'legacySeparate') {
    const screenEntries = entries.filter((entry) => entry.target === 'screen');
    const desktopEntries = entries.filter((entry) => entry.target !== 'screen');
    return {
      mode: 'legacySeparate',
      screenMemoryBlock: renderEntryGroup(screenEntries, { maxChars, maxEvidenceRefs }),
      desktopActivityBlock: renderEntryGroup(desktopEntries, { maxChars, maxEvidenceRefs }),
    };
  }

  return {
    mode: 'unified',
    activityContextBlock: renderEntryGroup(entries, { maxChars, maxEvidenceRefs }),
  };
}

export function sanitizeActivityText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<\/?\s*(system|assistant|user)\b[^>]*>/gi, (match) =>
      match.replace(/</g, '[').replace(/>/g, ']'),
    )
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/gi, '[neutralized instruction override]')
    .replace(/disregard\s+(all\s+)?(previous|prior|above)\s+instructions/gi, '[neutralized instruction override]')
    .replace(/forget\s+(all\s+)?(previous|prior|above)\s+instructions/gi, '[neutralized instruction override]')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeContext(
  context: ActivityContextLike | ActivityContextEntry[] | string | null | undefined,
): NormalizedActivityEntry[] {
  if (!context) return [];
  if (typeof context === 'string') {
    return normalizeEntry({ text: context, channel: 'activity-context' }, 0);
  }
  if (Array.isArray(context)) {
    return context.flatMap((entry, index) => normalizeEntry(entry, index));
  }

  const entries: ActivityContextEntry[] = [
    ...asEntryArray(context.entries),
    ...asEntryArray(context.items),
    ...asEntryArray(context.events),
  ];

  for (const source of context.sources ?? []) {
    const sourceName = source.source ?? context.source;
    if (source.text) {
      entries.push({
        source: sourceName,
        confidence: source.confidence ?? context.confidence,
        text: source.text,
        evidenceRefs: source.evidenceRefs,
        kind: sourceName ?? undefined,
      });
    }
    for (const item of source.items ?? []) {
      entries.push({
        ...item,
        source: item.source ?? sourceName,
        confidence: item.confidence ?? source.confidence ?? context.confidence,
        evidenceRefs: item.evidenceRefs ?? source.evidenceRefs,
        kind: item.kind ?? sourceName ?? undefined,
      });
    }
  }

  if (typeof context.screenMemoryBlock === 'string') {
    entries.push({ text: context.screenMemoryBlock, channel: 'screen-memory', source: context.source });
  }
  if (typeof context.desktopActivityBlock === 'string') {
    entries.push({ text: context.desktopActivityBlock, channel: 'desktop-activity', source: context.source });
  }
  appendNested(entries, context.screenMemory, 'screen-memory', context);
  appendNested(entries, context.desktopActivity, 'desktop-activity', context);
  if (context.summary) {
    entries.push({
      text: context.summary,
      channel: 'activity-context',
      source: context.source,
      confidence: context.confidence,
      evidenceRefs: context.evidenceRefs,
    });
  }

  return entries.flatMap((entry, index) => normalizeEntry(entry, index));
}

function asEntryArray(value: ActivityContextEntry[] | null | undefined): ActivityContextEntry[] {
  return Array.isArray(value) ? value : [];
}

function appendNested(
  target: ActivityContextEntry[],
  value: ActivityContextEntry[] | string | null | undefined,
  channel: ActivityContextEntry['channel'],
  defaults: Pick<ActivityContextLike, 'source' | 'confidence' | 'evidenceRefs'>,
): void {
  if (typeof value === 'string') {
    target.push({
      text: value,
      channel,
      source: defaults.source,
      confidence: defaults.confidence,
      evidenceRefs: defaults.evidenceRefs,
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      target.push({ ...entry, channel: entry.channel ?? channel });
    }
  }
}

function normalizeEntry(entry: ActivityContextEntry, index: number): NormalizedActivityEntry[] {
  const text = sanitizeActivityText(entry.summary ?? entry.text ?? entry.content ?? entry.title);
  if (!text) return [];

  return [{
    source: normalizeSource(entry.source),
    confidence: normalizeConfidence(entry.confidence),
    text,
    title: sanitizeOptional(entry.title),
    appName: sanitizeOptional(entry.appName ?? entry.app_name),
    windowTitle: sanitizeOptional(entry.windowTitle ?? entry.window_title),
    url: sanitizeOptional(entry.url ?? entry.browserUrl),
    timestamp: formatTimestamp(entry.timestamp ?? entry.capturedAtMs ?? entry.startAtMs),
    evidenceRefs: normalizeEvidenceRefs([...(entry.evidenceRefs ?? []), ...(entry.evidence ?? [])]),
    target: inferTarget(entry),
    originalIndex: index,
  }];
}

function normalizeSource(source: ActivityContextEntry['source']): ActivityContextSource {
  if (source && VALID_SOURCES.has(source as ActivityContextSource)) {
    return source as ActivityContextSource;
  }
  if (source === 'audio') return 'meeting-audio';
  if (source === 'screenshot-analysis') return 'screenshot-analysis';
  if (source === 'openchronicle') return 'automatic-background';
  if (source === 'tauri-native-desktop') return 'manual-session';
  return 'automatic-background';
}

function normalizeConfidence(confidence: number | null | undefined): number {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function sanitizeOptional(value: unknown): string | undefined {
  const text = sanitizeActivityText(value);
  return text || undefined;
}

function inferTarget(entry: ActivityContextEntry): NormalizedActivityEntry['target'] {
  const marker = `${entry.source ?? ''} ${entry.channel ?? ''} ${entry.contextType ?? ''} ${entry.kind ?? ''}`.toLowerCase();
  if (marker.includes('screen-memory') || marker.includes('openchronicle')) return 'screen';
  if (
    marker.includes('desktop') ||
    marker.includes('tauri-native') ||
    marker.includes('audio') ||
    marker.includes('screenshot')
  ) {
    return 'desktop';
  }
  return 'activity';
}

function formatTimestamp(value: ActivityContextEntry['timestamp'] | number | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return sanitizeOptional(value);
  return date.toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

function normalizeEvidenceRefs(refs: Array<string | ActivityEvidenceRef>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const ref of refs) {
    const text = normalizeEvidenceRef(ref);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeEvidenceRef(ref: string | ActivityEvidenceRef): string {
  if (typeof ref === 'string') {
    return shortenEvidenceText(ref);
  }
  const shortId = [ref.source, ref.kind, ref.id].filter(Boolean).join(':');
  return shortenEvidenceText(ref.label || shortId || ref.url || ref.path || '');
}

function shortenEvidenceText(value: string): string {
  const sanitized = sanitizeActivityText(value);
  if (!sanitized) return '';
  const looksLikePath = sanitized.includes('/') || sanitized.includes('\\');
  const compact = looksLikePath ? sanitized.split(/[\\/]/).filter(Boolean).pop() || sanitized : sanitized;
  if (compact.length <= 64) return compact;
  return `${compact.slice(0, 30)}…${compact.slice(-24)}`;
}

function renderEntryGroup(
  entries: NormalizedActivityEntry[],
  options: { maxChars: number; maxEvidenceRefs: number },
): string | null {
  const sorted = [...entries].sort(compareEntriesForPrompt);
  if (sorted.length === 0) return null;

  const lines: string[] = [];
  for (const entry of sorted) {
    lines.push(formatEntryLine(entry, options.maxEvidenceRefs));
  }
  return clampLines(lines, options.maxChars);
}

function compareEntriesForPrompt(a: NormalizedActivityEntry, b: NormalizedActivityEntry): number {
  const priorityA = sourcePriority(a.source) + a.confidence;
  const priorityB = sourcePriority(b.source) + b.confidence;
  if (priorityA !== priorityB) return priorityB - priorityA;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.originalIndex - b.originalIndex;
}

function sourcePriority(source: ActivityContextSource): number {
  return source === 'manual-session' ? MANUAL_SOURCE_BONUS : 0;
}

function formatEntryLine(entry: NormalizedActivityEntry, maxEvidenceRefs: number): string {
  const meta = [
    `source=${entry.source}`,
    `confidence=${entry.confidence.toFixed(2)}`,
    entry.timestamp ? `time=${entry.timestamp}` : '',
    entry.appName ? `app=${entry.appName}` : '',
    entry.windowTitle ? `window=${entry.windowTitle}` : '',
    entry.url ? `url=${entry.url}` : '',
  ].filter(Boolean);

  const evidence = entry.evidenceRefs.slice(0, maxEvidenceRefs);
  const evidenceText = evidence.length > 0 ? ` evidence=[${evidence.join(', ')}]` : '';
  return `- (${meta.join('; ')}) ${entry.text}${evidenceText}`;
}

function clampLines(lines: string[], maxChars: number): string | null {
  let output = '';
  for (const line of lines) {
    const candidate = output ? `${output}\n${line}` : line;
    if (candidate.length <= maxChars) {
      output = candidate;
      continue;
    }
    if (!output) {
      output = truncateAtBoundary(line, maxChars);
    }
    break;
  }
  return output.trim() || null;
}

function truncateAtBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = '\n[truncated]';
  const budget = Math.max(1, maxChars - suffix.length);
  return `${value.slice(0, budget).trimEnd()}${suffix}`;
}
