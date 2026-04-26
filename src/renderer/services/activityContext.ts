export type ActivityContextSourceKind =
  | 'automatic_background'
  | 'manual_capture'
  | 'meeting_audio'
  | 'screenshot_analysis'
  | 'unknown';

export interface ActivityContextSourcePreview {
  kind: ActivityContextSourceKind;
  label: string;
  summary: string;
}

export interface ActivityContextPreview {
  capturedAtMs?: number | null;
  status: 'ready' | 'empty';
  recentContextSummary: string;
  agentInjectionPreview: string;
  sources: ActivityContextSourcePreview[];
  evidence: string[];
}

type RawRecord = Record<string, unknown>;

const SOURCE_LABELS: Record<ActivityContextSourceKind, string> = {
  automatic_background: '自动后台',
  manual_capture: '手动采集',
  meeting_audio: '会议音频',
  screenshot_analysis: '截图分析',
  unknown: '未知来源',
};

const LOCAL_PATH_RE = /(?:\/Users\/[^\s'"`，。；、)）\]}]+|[A-Za-z]:\\[^\s'"`，。；、)）\]}]+)/g;
const SCREENSHOT_NAME_RE = /\b(?:collector|native_screenshot|screenshot|screen)[-_]?\d+\.(?:png|jpe?g|webp)\b/gi;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RawRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item): item is string => Boolean(item));
}

function compactText(value: string, maxChars = 240): string {
  const normalized = redactActivityEvidence(value).replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function redactActivityEvidence(value: string): string {
  return value
    .replace(LOCAL_PATH_RE, '[local path hidden]')
    .replace(SCREENSHOT_NAME_RE, '[screenshot hidden]')
    .trim();
}

function firstText(record: RawRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return redactActivityEvidence(value);
  }
  return null;
}

function normalizeSourceKind(value: unknown): ActivityContextSourceKind {
  const raw = asString(value)?.toLowerCase().replace(/[-\s]/g, '_') || '';
  if (['automatic_background', 'auto_background', 'background', 'collector', 'openchronicle'].includes(raw)) {
    return 'automatic_background';
  }
  if (['manual_capture', 'manual', 'user_capture', 'native_desktop', 'tauri_native_desktop'].includes(raw)) {
    return 'manual_capture';
  }
  if (['meeting_audio', 'audio', 'audio_segment', 'transcript', 'meeting'].includes(raw)) {
    return 'meeting_audio';
  }
  if (['screenshot_analysis', 'screenshot', 'vision', 'visual_analysis', 'screen_analysis'].includes(raw)) {
    return 'screenshot_analysis';
  }
  return 'unknown';
}

function inferSources(record: RawRecord): ActivityContextSourcePreview[] {
  const explicit = Array.isArray(record.sources) ? record.sources : [];
  const fromExplicit = explicit
    .map((item) => {
      if (typeof item === 'string') {
        const kind = normalizeSourceKind(item);
        return { kind, label: SOURCE_LABELS[kind], summary: SOURCE_LABELS[kind] };
      }
      const source = asRecord(item);
      if (!source) return null;
      const kind = normalizeSourceKind(source.kind || source.type || source.source);
      const status = asString(source.status);
      const text = asString(source.text);
      const items = Array.isArray(source.items) ? source.items : [];
      return {
        kind,
        label: asString(source.label) || SOURCE_LABELS[kind],
        summary: compactText(
          asString(source.summary) ||
          asString(source.detail) ||
          text ||
          (status === 'unavailable' ? asString(source.unavailableReason) : null) ||
          `${items.length} 条上下文`
        ),
      };
    })
    .filter((item): item is ActivityContextSourcePreview => Boolean(item));

  const inferred: ActivityContextSourcePreview[] = [...fromExplicit];
  const pushIfMissing = (kind: ActivityContextSourceKind, summary: string) => {
    if (!inferred.some((item) => item.kind === kind)) {
      inferred.push({ kind, label: SOURCE_LABELS[kind], summary });
    }
  };

  if (record.background || record.desktopActivity || record.activitySummary || record.recentContextSummary) {
    pushIfMissing('automatic_background', '桌面活动摘要');
  }
  if (record.manualCapture || record.captureSummary) {
    pushIfMissing('manual_capture', '手动采集摘要');
  }
  if (record.meetingAudio || record.audioSummary || record.transcriptSummary || record.audioSegments) {
    pushIfMissing('meeting_audio', '会议音频摘要');
  }
  if (record.screenshotAnalysis || record.visualSummary || record.analyzeText || record.visionSummary) {
    pushIfMissing('screenshot_analysis', '截图分析摘要');
  }

  return inferred.length > 0
    ? inferred
    : [{ kind: 'unknown', label: SOURCE_LABELS.unknown, summary: '后端尚未声明来源' }];
}

function summarizeActivitySource(source: RawRecord): string | null {
  const kind = normalizeSourceKind(source.kind || source.type || source.source);
  const label = SOURCE_LABELS[kind];
  const text = asString(source.text);
  if (text) return `${label}: ${compactText(text)}`;

  const items = Array.isArray(source.items) ? source.items : [];
  const itemTexts = items
    .map(asRecord)
    .filter((item): item is RawRecord => Boolean(item))
    .map((item) => firstText(item, ['summary', 'text', 'title', 'windowTitle', 'appName']))
    .filter((item): item is string => Boolean(item))
    .slice(0, 3);

  if (itemTexts.length > 0) return `${label}: ${itemTexts.map((item) => compactText(item, 96)).join(' / ')}`;

  const unavailableReason = asString(source.unavailableReason);
  if (unavailableReason) return `${label}: ${compactText(unavailableReason)}`;
  return null;
}

function extractEvidence(value: unknown): string[] {
  const direct = asStringArray(value);
  if (direct.length > 0) return direct;
  if (!Array.isArray(value)) return [];

  return value
    .map(asRecord)
    .filter((item): item is RawRecord => Boolean(item))
    .map((item) => {
      const label = asString(item.label);
      const id = asString(item.id);
      const kind = asString(item.kind);
      const path = asString(item.path);
      return [kind, label || id, path].filter(Boolean).join(': ');
    })
    .filter(Boolean);
}

export function normalizeActivityContextResponse(input: unknown): ActivityContextPreview {
  const root = asRecord(input);
  const data = asRecord(root?.data) || root;
  if (!data) {
    return {
      status: 'empty',
      recentContextSummary: '暂无可用屏幕上下文。',
      agentInjectionPreview: '暂无内容会注入 agent。',
      sources: [],
      evidence: [],
    };
  }

  const recentContextSummary = firstText(data, [
    'recentContextPreview',
    'recentContextSummary',
    'summary',
    'activitySummary',
    'contextSummary',
  ]) || (
    Array.isArray(data.sources)
      ? data.sources
          .map(asRecord)
          .filter((item): item is RawRecord => Boolean(item))
          .filter((item) => asString(item.status) !== 'unavailable')
          .map(summarizeActivitySource)
          .filter((item): item is string => Boolean(item))
          .slice(0, 4)
          .join('\n')
      : ''
  ) || '暂无可用屏幕上下文。';

  const agentInjectionPreview = firstText(data, [
    'agentInjectionPreview',
    'injectionPreview',
    'contextBlock',
    'agentContext',
    'promptPreview',
  ]) || (
    recentContextSummary !== '暂无可用屏幕上下文。'
      ? recentContextSummary
      : '后端尚未返回将注入 agent 的内容。'
  );

  const rawEvidence = [
    ...asStringArray(data.evidence),
    ...asStringArray(data.evidenceSummary),
    ...asStringArray(data.evidenceSummaries),
    ...extractEvidence(data.evidenceRefs),
  ];

  const evidence = rawEvidence
    .map(redactActivityEvidence)
    .filter(Boolean)
    .slice(0, 4);

  return {
    capturedAtMs: asNumber(data.capturedAtMs) || asNumber(data.generatedAtMs) || asNumber(data.updatedAtMs),
    status: recentContextSummary === '暂无可用屏幕上下文。' && agentInjectionPreview === '后端尚未返回将注入 agent 的内容。'
      ? 'empty'
      : 'ready',
    recentContextSummary,
    agentInjectionPreview,
    sources: inferSources(data),
    evidence,
  };
}

export async function getCurrentActivityContext(): Promise<ActivityContextPreview> {
  const { default: ipcService } = await import('./ipcService');
  const { IPC_DOMAINS } = await import('@shared/ipc');
  const result = await ipcService.invokeDomain<unknown>(IPC_DOMAINS.ACTIVITY, 'getCurrentContext');
  return normalizeActivityContextResponse(result);
}
