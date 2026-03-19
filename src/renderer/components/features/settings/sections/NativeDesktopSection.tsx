// ============================================================================
// NativeDesktopSection - 桌面活动时间线
// 左侧 24 小时时间轴（有活动的小时显示卡片）+ 右侧详情
// ============================================================================

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Play,
  Square,
  Monitor,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Image as ImageIcon,
  X,
  FileText,
  ArrowLeft,
  Mic,
  MicOff,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import {
  getNativeDesktopCollectorStatus,
  listRecentNativeDesktopEvents,
  listAudioSegments,
  startNativeDesktopCollector,
  stopNativeDesktopCollector,
  startAudioCapture,
  stopAudioCapture,
  getAudioCaptureStatus,
  type AudioSegment,
  type AudioCaptureStatus,
  type DesktopActivityEvent,
  type NativeDesktopCollectorStatus,
} from '../../../../services/nativeDesktop';

// ============================================================================
// Types
// ============================================================================

interface ActivitySegment {
  appName: string;
  startMs: number;
  endMs: number;
  events: DesktopActivityEvent[];
  title: string;
}

interface AppCluster {
  appName: string;
  totalDurationMs: number;
  eventCount: number;
  segments: ActivitySegment[];
}

const MEETING_APP_NAMES = new Set([
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

interface HourBlock {
  hour: number; // 0-23
  label: string; // "09:00"
  segments: ActivitySegment[];
  eventCount: number;
}

// ============================================================================
// Helpers
// ============================================================================

function groupEventsIntoSegments(events: DesktopActivityEvent[]): ActivitySegment[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  const segments: ActivitySegment[] = [];
  let current: ActivitySegment | null = null;

  for (const event of sorted) {
    if (
      current &&
      current.appName === event.appName &&
      event.capturedAtMs - current.endMs < 10 * 60 * 1000
    ) {
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

function build24HourBlocks(events: DesktopActivityEvent[]): HourBlock[] {
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

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}


function clusterAppsByDuration(segments: ActivitySegment[], intervalSecs: number): AppCluster[] {
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

function formatDurationShort(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1 分钟';
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${y}-${m}-${d} ${weekdays[date.getDay()]}`;
}

function appColor(appName: string): string {
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

function appInitial(appName: string): string {
  return appName.replace(/\.app$/, '').trim().charAt(0).toUpperCase();
}

/** 对音频段按时间间隔分主题组 — 超过 60s 静默视为新话题 */
interface TopicGroup {
  label: string;
  startMs: number;
  endMs: number;
  segments: AudioSegment[];
}

function clusterAudioTopics(segs: AudioSegment[]): TopicGroup[] {
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

function speakerStyle(id: number) {
  return SPEAKER_COLORS[(id - 1) % SPEAKER_COLORS.length] || SPEAKER_COLORS[0];
}

/** 对没有换行的旧分析文本做智能分段，已有 markdown 格式的保留原样 */
function formatAnalysisText(text: string): string {
  // Already has markdown structure (bullet points, headings, or line breaks)
  if (/[\n]/.test(text) || /^[-*#]/.test(text.trim())) return text;
  // Split long single-paragraph Chinese text by sentence-ending punctuation
  // Insert line breaks after 。；to create paragraphs
  return text
    .replace(/([。；])\s*/g, '$1\n\n')
    .trim();
}

// ============================================================================
// Screenshot components
// ============================================================================

const ScreenshotImage: React.FC<{ path: string; className?: string; onClick?: () => void }> = ({
  path, className, onClick,
}) => {
  const [error, setError] = useState(false);
  if (error || !path) {
    return (
      <div className={`flex items-center justify-center bg-zinc-800 text-zinc-600 ${className || ''}`}>
        <ImageIcon className="w-5 h-5" />
      </div>
    );
  }
  return (
    <img
      src={`/api/screenshot?path=${encodeURIComponent(path)}`}
      alt="Screenshot"
      className={`object-cover ${onClick ? 'cursor-pointer hover:brightness-110 transition-all' : ''} ${className || ''}`}
      onError={() => setError(true)}
      onClick={onClick}
    />
  );
};

const ScreenshotLightbox: React.FC<{ path: string; onClose: () => void }> = ({ path, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
    <button className="absolute top-4 right-4 p-2 rounded-full bg-zinc-800/80 text-zinc-300 hover:text-white" onClick={onClose}>
      <X className="w-5 h-5" />
    </button>
    <img
      src={`/api/screenshot?path=${encodeURIComponent(path)}`}
      alt="Screenshot"
      className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    />
  </div>
);

// ============================================================================
// Left: 24-hour timeline sidebar
// ============================================================================

const HourSlot: React.FC<{
  block: HourBlock;
  selected: boolean;
  onClick: () => void;
}> = ({ block, selected, onClick }) => {
  const hasActivity = block.eventCount > 0;
  // Top apps in this hour
  const topApps = useMemo(() => {
    const map = new Map<string, number>();
    for (const seg of block.segments) {
      map.set(seg.appName, (map.get(seg.appName) || 0) + seg.events.length);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
  }, [block]);

  return (
    <button
      onClick={onClick}
      disabled={!hasActivity}
      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors ${
        selected
          ? 'bg-cyan-500/10 border-r-2 border-cyan-400'
          : hasActivity
            ? 'hover:bg-zinc-800/60'
            : ''
      }`}
    >
      {/* Hour label */}
      <span className={`text-[11px] font-mono w-10 shrink-0 ${
        hasActivity ? 'text-zinc-300' : 'text-zinc-700'
      }`}>
        {block.label}
      </span>

      {hasActivity ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {/* App dots */}
          <div className="flex -space-x-1">
            {topApps.map((app) => (
              <div
                key={app}
                className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-medium ring-1 ring-zinc-900 ${appColor(app)}`}
                title={app}
              >
                {appInitial(app)}
              </div>
            ))}
          </div>
          {/* Event count */}
          <span className="text-[10px] text-zinc-500 shrink-0">{block.eventCount}</span>
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </button>
  );
};

// ============================================================================
// Meeting detail panel (full overlay)
// ============================================================================

const MeetingDetailPanel: React.FC<{
  appName: string;
  audioSegs: AudioSegment[];
  onClose: () => void;
}> = ({ appName, audioSegs, onClose }) => {
  const topics = useMemo(() => clusterAudioTopics(audioSegs), [audioSegs]);
  const [activeTopic, setActiveTopic] = useState<number>(0);
  const transcriptRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const totalDuration = audioSegs.length > 0
    ? audioSegs[audioSegs.length - 1].end_at_ms - audioSegs[0].start_at_ms
    : 0;
  const speakerIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of audioSegs) if (s.speaker_id && s.speaker_id > 0) ids.add(s.speaker_id);
    return Array.from(ids).sort();
  }, [audioSegs]);

  const scrollToTopic = (idx: number) => {
    setActiveTopic(idx);
    const firstSeg = topics[idx]?.segments[0];
    if (firstSeg) {
      const el = transcriptRefs.current.get(audioSegs.indexOf(firstSeg));
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="absolute inset-0 z-20 bg-zinc-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-700/50 shrink-0">
        <button onClick={onClose} className="p-1 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-200">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-medium ${appColor(appName)}`}>
          {appInitial(appName)}
        </div>
        <div>
          <div className="text-sm font-medium text-zinc-200">{appName} · 会议详情</div>
          <div className="text-[11px] text-zinc-500">
            {audioSegs.length} 段发言 · {formatDurationShort(totalDuration)}
            {speakerIds.length > 0 && ` · ${speakerIds.length} 位说话人`}
          </div>
        </div>
      </div>

      {/* Body: left topics + right transcript */}
      <div className="flex flex-1 min-h-0">
        {/* Left: topic timeline */}
        <div className="w-[200px] border-r border-zinc-700/30 overflow-y-auto shrink-0 py-3">
          {/* Speaker legend */}
          {speakerIds.length > 0 && (
            <div className="px-4 pb-3 mb-3 border-b border-zinc-800/50">
              <div className="text-[10px] text-zinc-600 mb-1.5">说话人</div>
              <div className="space-y-1">
                {speakerIds.map((id) => {
                  const style = speakerStyle(id);
                  return (
                    <div key={id} className="flex items-center gap-1.5">
                      <div className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
                      <span className={`text-[11px] ${style.text}`}>说话人 {id}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Topic list */}
          <div className="px-2 space-y-0.5">
            {topics.map((topic, idx) => (
              <button
                key={idx}
                onClick={() => scrollToTopic(idx)}
                className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
                  activeTopic === idx
                    ? 'bg-cyan-500/10 border border-cyan-500/20'
                    : 'hover:bg-zinc-800/60 border border-transparent'
                }`}
              >
                <div className="text-[10px] text-zinc-600 font-mono">
                  {formatTime(topic.startMs)} - {formatTime(topic.endMs)}
                </div>
                <div className="text-[12px] text-zinc-300 mt-0.5 line-clamp-2 leading-snug">
                  {topic.label}
                </div>
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {topic.segments.length} 段
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: full transcript */}
        <div className="flex-1 overflow-y-auto py-4 px-5">
          <div className="space-y-1">
            {audioSegs.map((seg, idx) => {
              const spkId = seg.speaker_id && seg.speaker_id > 0 ? seg.speaker_id : 0;
              const style = spkId > 0 ? speakerStyle(spkId) : null;

              // Check if we're entering a new topic — insert topic header
              let topicHeader: string | null = null;
              for (const topic of topics) {
                if (topic.segments[0] === seg) {
                  topicHeader = topic.label;
                  break;
                }
              }

              return (
                <React.Fragment key={seg.id}>
                  {topicHeader && (
                    <div className="flex items-center gap-2 pt-4 pb-2 first:pt-0">
                      <div className="h-px flex-1 bg-zinc-700/50" />
                      <span className="text-[10px] text-zinc-500 shrink-0">{topicHeader}</span>
                      <div className="h-px flex-1 bg-zinc-700/50" />
                    </div>
                  )}
                  <div
                    ref={(el) => { if (el) transcriptRefs.current.set(idx, el); }}
                    className="flex gap-3 py-1.5 group"
                  >
                    <span className="text-zinc-600 font-mono text-[11px] w-11 shrink-0 text-right pt-0.5">
                      {formatTime(seg.start_at_ms)}
                    </span>
                    {style ? (
                      <div className={`shrink-0 w-16 flex items-center gap-1 pt-0.5`}>
                        <div className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
                        <span className={`text-[10px] font-medium ${style.text}`}>
                          说话人{spkId}
                        </span>
                      </div>
                    ) : (
                      <div className="w-16 shrink-0" />
                    )}
                    <span className="text-[13px] text-zinc-300 leading-relaxed">{seg.transcript}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Right: hour detail panel
// ============================================================================

const AppGroupCard: React.FC<{
  cluster: AppCluster;
  audioSegs: AudioSegment[];
  expanded: boolean;
  onToggle: () => void;
  onScreenshotClick: (path: string) => void;
  onOpenMeeting?: () => void;
}> = ({ cluster, audioSegs, expanded, onToggle, onScreenshotClick, onOpenMeeting }) => {
  const isMeeting = MEETING_APP_NAMES.has(cluster.appName);
  const allEvents = cluster.segments.flatMap((s) => s.events);
  const allScreenshots = allEvents.filter((e) => e.screenshotPath);
  const allAnalyses = allEvents
    .filter((e) => e.analyzeText)
    .sort((a, b) => (b.analyzeText?.length || 0) - (a.analyzeText?.length || 0));
  const bestAnalysis = allAnalyses[0]?.analyzeText;

  // Collect unique tab/window titles with timestamps
  const tabEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: Array<{ title: string; time: number }> = [];
    for (const ev of allEvents) {
      // Prefer browserTitle (tab name) > windowTitle
      const title = ev.browserTitle || ev.windowTitle || '';
      if (title && title !== cluster.appName && !seen.has(title)) {
        seen.add(title);
        entries.push({ title, time: ev.capturedAtMs });
      }
    }
    return entries.slice(0, 6);
  }, [cluster, allEvents]);

  return (
    <div className="rounded-xl border border-zinc-700/40 bg-zinc-800/20 overflow-hidden">
      {/* Header — clickable to expand/collapse */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-zinc-700/20 transition-colors"
      >
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-medium shrink-0 ${appColor(cluster.appName)}`}>
          {appInitial(cluster.appName)}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="text-sm font-medium text-zinc-200">
            {cluster.appName}
            {isMeeting && audioSegs.length > 0 && (
              <span className="ml-2 text-[10px] text-amber-400 font-normal">会议记录 {audioSegs.length} 段</span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500">
            {formatDurationShort(cluster.totalDurationMs)} · {cluster.eventCount} 条记录
            {allScreenshots.length > 0 && ` · ${allScreenshots.length} 张截图`}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-zinc-700/30">
          {/* Screenshots gallery */}
          {allScreenshots.length > 0 && (
            <div className="flex gap-1.5 p-2 overflow-x-auto">
              {allScreenshots.slice(0, 8).map((ev, i) => (
                <ScreenshotImage
                  key={i}
                  path={ev.screenshotPath!}
                  className={`${allScreenshots.length === 1 ? 'w-full h-44' : 'w-52 h-32 shrink-0'} rounded-lg`}
                  onClick={() => onScreenshotClick(ev.screenshotPath!)}
                />
              ))}
              {allScreenshots.length > 8 && (
                <div className="w-20 h-32 shrink-0 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-500 text-xs">
                  +{allScreenshots.length - 8}
                </div>
              )}
            </div>
          )}

          <div className="px-4 py-3 space-y-3">
            {/* Tab / window titles with time */}
            {tabEntries.length > 0 && (
              <div className="space-y-1">
                {tabEntries.map((entry, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px]">
                    <span className="text-zinc-600 font-mono shrink-0 w-11 text-right pt-px">
                      {formatTime(entry.time)}
                    </span>
                    <span className="text-zinc-300 line-clamp-1">{entry.title}</span>
                  </div>
                ))}
              </div>
            )}

            {/* AI analysis — markdown with auto-paragraph for legacy text */}
            {bestAnalysis && (
              <div className="text-[13px] text-zinc-400 leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-ul:my-1 prose-li:my-0.5 prose-strong:text-zinc-300">
                <ReactMarkdown>{formatAnalysisText(bestAnalysis)}</ReactMarkdown>
              </div>
            )}

            {/* Meeting summary + detail entry */}
            {isMeeting && audioSegs.length > 0 && (
              <div className="mt-3 pt-3 border-t border-zinc-700/30">
                {/* Quick summary: speaker count + segment count + duration */}
                <div className="flex items-center gap-2 text-[12px] text-zinc-400 mb-2">
                  <FileText className="w-3.5 h-3.5 text-amber-400" />
                  <span>
                    {audioSegs.length} 段发言
                    {(() => {
                      const ids = new Set(audioSegs.filter((s) => s.speaker_id && s.speaker_id > 0).map((s) => s.speaker_id));
                      return ids.size > 0 ? ` · ${ids.size} 位说话人` : '';
                    })()}
                    {audioSegs.length >= 2 && ` · ${formatDurationShort(audioSegs[audioSegs.length - 1].end_at_ms - audioSegs[0].start_at_ms)}`}
                  </span>
                </div>
                {/* Preview: first 3 transcript lines */}
                <div className="space-y-0.5 mb-2">
                  {audioSegs.slice(0, 3).map((seg) => {
                    const spkId = seg.speaker_id && seg.speaker_id > 0 ? seg.speaker_id : 0;
                    const style = spkId > 0 ? speakerStyle(spkId) : null;
                    return (
                      <div key={seg.id} className="flex gap-1.5 text-[12px]">
                        {style && (
                          <span className={`shrink-0 ${style.text}`}>说话人{spkId}:</span>
                        )}
                        <span className="text-zinc-400 line-clamp-1">{seg.transcript}</span>
                      </div>
                    );
                  })}
                  {audioSegs.length > 3 && (
                    <div className="text-[11px] text-zinc-600">...还有 {audioSegs.length - 3} 段</div>
                  )}
                </div>
                {/* Detail entry button */}
                <button
                  onClick={onOpenMeeting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[12px] hover:bg-amber-500/20 transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  查看会议详情
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const HourDetailPanel: React.FC<{ block: HourBlock; date: Date }> = ({ block, date }) => {
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);
  const [audioSegs, setAudioSegs] = useState<AudioSegment[]>([]);
  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(new Set());
  const [meetingDetailApp, setMeetingDetailApp] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const appGroupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Load audio segments for this hour
  useEffect(() => {
    const dayStart = new Date(date);
    dayStart.setHours(block.hour, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(block.hour, 59, 59, 999);
    listAudioSegments(dayStart.getTime(), dayEnd.getTime()).then(setAudioSegs);
  }, [block.hour, date]);

  // Reset state when hour changes
  useEffect(() => {
    setCollapsedApps(new Set());
    setMeetingDetailApp(null);
  }, [block.hour]);

  const appClusters = useMemo(() => clusterAppsByDuration(block.segments, 30), [block.segments]);
  const appSet = new Set(block.segments.map((s) => s.appName));

  if (block.eventCount === 0 && audioSegs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600">
        <div className="text-center">
          <Monitor className="w-8 h-8 mx-auto mb-2 text-zinc-700" />
          <div className="text-sm">该时段无活动记录</div>
        </div>
      </div>
    );
  }

  const toggleApp = (appName: string) => {
    setCollapsedApps((prev) => {
      const next = new Set(prev);
      if (next.has(appName)) next.delete(appName);
      else next.add(appName);
      return next;
    });
  };

  const scrollToApp = (appName: string) => {
    // Ensure expanded and scroll
    setCollapsedApps((prev) => { const next = new Set(prev); next.delete(appName); return next; });
    requestAnimationFrame(() => {
      const el = appGroupRefs.current.get(appName);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div ref={scrollContainerRef} className="h-full overflow-y-auto">
      {/* Hour header summary */}
      <div className="px-5 py-4 border-b border-zinc-800/50 sticky top-0 bg-zinc-900/95 backdrop-blur-sm z-10">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-medium text-zinc-200">{block.label}</h2>
          <span className="text-xs text-zinc-500">
            {block.eventCount} 条记录 · {appSet.size} 个应用
          </span>
        </div>

        {/* Clickable app chips — scroll to group */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {appClusters.map((cluster) => (
            <button
              key={cluster.appName}
              onClick={() => scrollToApp(cluster.appName)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/60 border border-zinc-700/40 hover:bg-zinc-700/60 hover:border-zinc-600/60 transition-colors"
            >
              <div className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-medium ${appColor(cluster.appName)}`}>
                {appInitial(cluster.appName)}
              </div>
              <span className="text-[11px] text-zinc-300">{cluster.appName}</span>
              <span className="text-[10px] text-zinc-500">
                {formatDurationShort(cluster.totalDurationMs)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* App groups */}
      <div className="px-5 py-4 space-y-3">
        {appClusters.map((cluster) => {
          const isMeeting = MEETING_APP_NAMES.has(cluster.appName);
          const clusterAudioSegs = isMeeting ? audioSegs : [];
          return (
            <div
              key={cluster.appName}
              ref={(el) => { if (el) appGroupRefs.current.set(cluster.appName, el); }}
            >
              <AppGroupCard
                cluster={cluster}
                audioSegs={clusterAudioSegs}
                expanded={!collapsedApps.has(cluster.appName)}
                onToggle={() => toggleApp(cluster.appName)}
                onScreenshotClick={(p) => setLightboxPath(p)}
                onOpenMeeting={isMeeting && clusterAudioSegs.length > 0 ? () => setMeetingDetailApp(cluster.appName) : undefined}
              />
            </div>
          );
        })}
      </div>

      {/* Meeting detail overlay */}
      {meetingDetailApp && (
        <MeetingDetailPanel
          appName={meetingDetailApp}
          audioSegs={audioSegs}
          onClose={() => setMeetingDetailApp(null)}
        />
      )}

      {lightboxPath && <ScreenshotLightbox path={lightboxPath} onClose={() => setLightboxPath(null)} />}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const NativeDesktopSection: React.FC = () => {
  const [collectorStatus, setCollectorStatus] = useState<NativeDesktopCollectorStatus | null>(null);
  const [recentEvents, setRecentEvents] = useState<DesktopActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collectorBusy, setCollectorBusy] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedHour, setSelectedHour] = useState<number>(new Date().getHours());
  const [audioStatus, setAudioStatus] = useState<AudioCaptureStatus | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const hourListRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    try {
      const [status, events, audio] = await Promise.all([
        getNativeDesktopCollectorStatus(),
        listRecentNativeDesktopEvents(50),
        getAudioCaptureStatus(),
      ]);
      setCollectorStatus(status);
      setRecentEvents(events);
      if (audio) setAudioStatus(audio);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!collectorStatus?.running && !audioStatus?.capturing) return;
    const timer = window.setInterval(loadData, 5000);
    return () => window.clearInterval(timer);
  }, [collectorStatus?.running, audioStatus?.capturing, loadData]);

  const handleToggleCollector = async () => {
    setCollectorBusy(true);
    setError(null);
    try {
      if (collectorStatus?.running) {
        setCollectorStatus(await stopNativeDesktopCollector());
      } else {
        setCollectorStatus(await startNativeDesktopCollector({
          intervalSecs: 30,
          captureScreenshots: true,
          redactSensitiveContexts: true,
          retentionDays: 7,
          dedupeWindowSecs: 60,
          maxRecentEvents: 50,
        }));
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollectorBusy(false);
    }
  };

  const handleToggleAudio = async () => {
    setAudioBusy(true);
    setError(null);
    try {
      const result = audioStatus?.capturing
        ? await stopAudioCapture()
        : await startAudioCapture();
      if (result) setAudioStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAudioBusy(false);
    }
  };

  const navigateDate = (delta: number) => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + delta);
    setCurrentDate(d);
  };

  // Filter to current date
  const filteredEvents = useMemo(() => {
    const dayStart = new Date(currentDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(23, 59, 59, 999);
    return recentEvents.filter(
      (e) => e.capturedAtMs >= dayStart.getTime() && e.capturedAtMs <= dayEnd.getTime()
    );
  }, [recentEvents, currentDate]);

  const hourBlocks = useMemo(() => build24HourBlocks(filteredEvents), [filteredEvents]);
  const selectedBlock = hourBlocks[selectedHour];

  // Auto-scroll to current hour on mount
  useEffect(() => {
    if (hourListRef.current) {
      const el = hourListRef.current.children[selectedHour] as HTMLElement;
      el?.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, []);

  // Stats
  const totalEvents = filteredEvents.length;
  const appCount = new Set(filteredEvents.map((e) => e.appName)).size;
  const screenshotCount = filteredEvents.filter((e) => e.screenshotPath).length;
  const analyzedCount = filteredEvents.filter((e) => e.analyzeText).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-700/50 shrink-0">
        <div className="flex items-center gap-2.5">
          <Monitor className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-medium text-zinc-200">桌面活动</span>
          <div className={`px-1.5 py-0.5 rounded-full text-[10px] ${
            collectorStatus?.running
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-zinc-700/40 text-zinc-500 border border-zinc-600/30'
          }`}>
            {collectorStatus?.running ? '采集中' : '已停止'}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button onClick={() => navigateDate(-1)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] text-zinc-400 w-[110px] text-center">{formatDate(currentDate)}</span>
            <button onClick={() => navigateDate(1)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={handleToggleAudio}
            disabled={audioBusy}
            title={audioStatus?.capturing ? '停止录音' : '开始录音（会议纪要）'}
            className={`px-2.5 py-1 rounded-lg text-[11px] inline-flex items-center gap-1 transition-colors ${
              audioStatus?.capturing
                ? 'bg-rose-600/80 text-white hover:bg-rose-500 animate-pulse'
                : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
            } disabled:opacity-50`}
          >
            {audioStatus?.capturing ? (
              <><MicOff className="w-3 h-3" /> 录音中</>
            ) : (
              <><Mic className="w-3 h-3" /> 录音</>
            )}
          </button>

          <button
            onClick={handleToggleCollector}
            disabled={collectorBusy}
            className={`px-2.5 py-1 rounded-lg text-[11px] inline-flex items-center gap-1 transition-colors ${
              collectorStatus?.running
                ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                : 'bg-cyan-600 text-white hover:bg-cyan-500'
            } disabled:opacity-50`}
          >
            {collectorStatus?.running ? (
              <><Square className="w-3 h-3" /> 停止</>
            ) : (
              <><Play className="w-3 h-3" /> 采集</>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 p-2 rounded-lg border border-rose-500/20 bg-rose-500/10 text-xs text-rose-300 shrink-0">
          {error}
        </div>
      )}

      {/* Stats bar */}
      {totalEvents > 0 && (
        <div className="flex items-center gap-4 px-5 py-2 border-b border-zinc-800/50 text-[11px] text-zinc-500 shrink-0">
          <span>{totalEvents} 条记录</span>
          <span>{appCount} 个应用</span>
          {screenshotCount > 0 && <span>{screenshotCount} 张截图</span>}
          {analyzedCount > 0 && <span>{analyzedCount} 条 AI 分析</span>}
          {audioStatus?.capturing && (
            <span className="text-rose-400">
              录音中 · {audioStatus.totalSegments} 段 · {audioStatus.asrEngine}
            </span>
          )}
        </div>
      )}

      {/* Main: left 24h timeline + right detail */}
      <div className="flex flex-1 min-h-0">
        {/* Left: 24-hour slots */}
        <div ref={hourListRef} className="w-[160px] border-r border-zinc-700/30 overflow-y-auto shrink-0">
          {[...hourBlocks].reverse().map((block) => (
            <HourSlot
              key={block.hour}
              block={block}
              selected={selectedHour === block.hour}
              onClick={() => setSelectedHour(block.hour)}
            />
          ))}
        </div>

        {/* Right: detail for selected hour */}
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="flex items-center justify-center h-full text-xs text-zinc-500">加载中...</div>
          ) : (
            <HourDetailPanel block={selectedBlock} date={currentDate} />
          )}
        </div>
      </div>
    </div>
  );
};
