import type { AudioSegment, DesktopActivityEvent } from '../../../../services/nativeDesktop';

// ============================================================================
// Types
// ============================================================================

export interface ActivitySegment {
  appName: string;
  startMs: number;
  endMs: number;
  events: DesktopActivityEvent[];
  title: string;
}

export interface AppCluster {
  appName: string;
  totalDurationMs: number;
  eventCount: number;
  segments: ActivitySegment[];
}

export const MEETING_APP_NAMES = new Set([
  'zoom.us', 'Zoom', 'zoom',
  '飞书', 'Lark', 'Feishu',
  '钉钉', 'DingTalk',
  '腾讯会议', 'Tencent Meeting', 'WeMeet',
  '企业微信', 'WeChat Work', 'WeCom',
  'Microsoft Teams', 'Teams',
  'Slack', 'Google Meet',
  'Webex', 'Cisco Webex Meetings',
  'Discord', 'FaceTime',
]);

export interface HourBlock {
  hour: number; // 0-23
  label: string; // "09:00"
  segments: ActivitySegment[];
  eventCount: number;
}

export interface NativeDesktopSectionProps {
  onClose?: () => void;
  variant?: 'embedded' | 'fullscreen';
}

// ============================================================================
// Helpers
// ============================================================================

export function groupEventsIntoSegments(events: DesktopActivityEvent[]): ActivitySegment[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  const segments: ActivitySegment[] = [];
  let current: ActivitySegment | null = null;

  for (const event of sorted) {
    if (current === null) {
      current = {
        appName: event.appName,
        startMs: event.capturedAtMs,
        endMs: event.capturedAtMs,
        events: [event],
        title: '',
      };
      segments.push(current);
      continue;
    }

    if (current.appName === event.appName && event.capturedAtMs - current.endMs < 10 * 60 * 1000) {
      current.endMs = event.capturedAtMs;
      current.events.push(event);
    } else {
      current = {
        appName: event.appName,
        startMs: event.capturedAtMs,
        endMs: event.capturedAtMs,
        events: [event],
        title: '',
      };
      segments.push(current);
    }
  }

  for (const seg of segments) {
    const titleCounts = new Map<string, number>();
    for (const ev of seg.events) {
      const t = ev.windowTitle || ev.browserTitle || '';
      if (t) titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [t, c] of titleCounts) {
      if (c > bestCount) { best = t; bestCount = c; }
    }
    seg.title = best || seg.appName;
  }

  return segments;
}

export function build24HourBlocks(events: DesktopActivityEvent[]): HourBlock[] {
  const segments = groupEventsIntoSegments(events);
  const blocks: HourBlock[] = [];

  for (let h = 0; h < 24; h++) {
    const hourStart = h * 3600_000;
    const hourEnd = (h + 1) * 3600_000;
    // Get segments that overlap with this hour (use time-of-day offset)
    const hourSegments = segments.filter((s) => {
      const sStart = timeOfDay(s.startMs);
      const sEnd = timeOfDay(s.endMs);
      return sEnd >= hourStart && sStart < hourEnd;
    });
    const eventCount = hourSegments.reduce((n, s) => n + s.events.length, 0);
    blocks.push({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      segments: hourSegments,
      eventCount,
    });
  }

  return blocks;
}

function timeOfDay(ms: number): number {
  const d = new Date(ms);
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}


export function clusterAppsByDuration(segments: ActivitySegment[], intervalSecs: number): AppCluster[] {
  const map = new Map<string, { totalMs: number; count: number; segs: ActivitySegment[] }>();
  for (const seg of segments) {
    const dur = Math.max(seg.endMs - seg.startMs, intervalSecs * 1000);
    const existing = map.get(seg.appName);
    if (existing) {
      existing.totalMs += dur;
      existing.count += seg.events.length;
      existing.segs.push(seg);
    } else {
      map.set(seg.appName, { totalMs: dur, count: seg.events.length, segs: [seg] });
    }
  }
  return Array.from(map.entries())
    .map(([appName, { totalMs, count, segs }]) => ({ appName, totalDurationMs: totalMs, eventCount: count, segments: segs }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}

export function formatDurationShort(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1 分钟';
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${y}-${m}-${d} ${weekdays[date.getDay()]}`;
}

export function appColor(appName: string): string {
  const colors = [
    'bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-amber-500',
    'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
    'bg-orange-500', 'bg-pink-500',
  ];
  let hash = 0;
  for (let i = 0; i < appName.length; i++) {
    hash = ((hash << 5) - hash + appName.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

export function appInitial(appName: string): string {
  return appName.replace(/\.app$/, '').trim().charAt(0).toUpperCase();
}

/** 对音频段按时间间隔分主题组 — 超过 60s 静默视为新话题 */
export interface TopicGroup {
  label: string;
  startMs: number;
  endMs: number;
  segments: AudioSegment[];
}

export function clusterAudioTopics(segs: AudioSegment[]): TopicGroup[] {
  if (segs.length === 0) return [];
  const sorted = [...segs].sort((a, b) => a.start_at_ms - b.start_at_ms);
  const groups: TopicGroup[] = [];
  let current: TopicGroup = {
    label: '',
    startMs: sorted[0].start_at_ms,
    endMs: sorted[0].end_at_ms,
    segments: [sorted[0]],
  };

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].start_at_ms - current.endMs;
    if (gap > 60_000) {
      // Finalize current group
      current.label = extractTopicLabel(current.segments);
      groups.push(current);
      current = {
        label: '',
        startMs: sorted[i].start_at_ms,
        endMs: sorted[i].end_at_ms,
        segments: [sorted[i]],
      };
    } else {
      current.endMs = Math.max(current.endMs, sorted[i].end_at_ms);
      current.segments.push(sorted[i]);
    }
  }
  current.label = extractTopicLabel(current.segments);
  groups.push(current);
  return groups;
}

function extractTopicLabel(segs: AudioSegment[]): string {
  // Take first ~30 chars from the first segment as topic label
  const text = segs.map((s) => s.transcript).join('');
  if (text.length <= 20) return text || '对话';
  return text.slice(0, 20) + '...';
}

const SPEAKER_COLORS = [
  { bg: 'bg-blue-500/20', text: 'text-blue-300', dot: 'bg-blue-400' },
  { bg: 'bg-emerald-500/20', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  { bg: 'bg-purple-500/20', text: 'text-purple-300', dot: 'bg-purple-400' },
  { bg: 'bg-amber-500/20', text: 'text-amber-300', dot: 'bg-amber-400' },
  { bg: 'bg-rose-500/20', text: 'text-rose-300', dot: 'bg-rose-400' },
  { bg: 'bg-cyan-500/20', text: 'text-cyan-300', dot: 'bg-cyan-400' },
];

export function speakerStyle(id: number) {
  return SPEAKER_COLORS[(id - 1) % SPEAKER_COLORS.length] || SPEAKER_COLORS[0];
}

/** 对没有换行的旧分析文本做智能分段，已有 markdown 格式的保留原样 */
export function formatAnalysisText(text: string): string {
  // Already has markdown structure (bullet points, headings, or line breaks)
  if (/[\n]/.test(text) || /^[-*#]/.test(text.trim())) return text;
  // Split long single-paragraph Chinese text by sentence-ending punctuation
  // Insert line breaks after 。；to create paragraphs
  return text
    .replace(/([。；])\s*/g, '$1\n\n')
    .trim();
}
