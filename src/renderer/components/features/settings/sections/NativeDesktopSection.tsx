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
  Volume2,
  Eye,
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

import {
  appColor,
  appInitial,
  build24HourBlocks,
  buildMeetingAppNameSet,
  clusterAppsByDuration,
  clusterAudioTopics,
  formatAnalysisText,
  formatDate,
  formatDurationShort,
  formatTime,
  speakerStyle,
  type AppCluster,
  type HourBlock,
  type NativeDesktopSectionProps,
} from './nativeDesktopActivityModel';
import { useI18n } from '../../../../hooks/useI18n';

type NativeDesktopText = ReturnType<typeof useI18n>['t']['settings']['nativeDesktop'];

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
    <button /* ds-allow:button: 灯箱关闭按钮，绝对定位圆形图标按钮，无文字，primitive 变体会强加 bg/padding 改变外观 */ className="absolute top-4 right-4 p-2 rounded-full bg-zinc-800/80 text-zinc-300 hover:text-white" onClick={onClose}>
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
    <button /* ds-allow:button: 全宽时间轴行，左对齐+选中态右边框+应用点阵，primitive 居中变体不兼容 */
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
  text: NativeDesktopText;
  onClose: () => void;
}> = ({ appName, audioSegs, text, onClose }) => {
  const topics = useMemo(() => clusterAudioTopics(audioSegs, text.topics), [audioSegs, text]);
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
        <button /* ds-allow:button: 会议详情返回按钮，纯图标 p-1，primitive 变体会改变尺寸与外观 */ onClick={onClose} className="p-1 rounded hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-200">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-white text-[10px] font-medium ${appColor(appName)}`}>
          {appInitial(appName)}
        </div>
        <div>
          <div className="text-sm font-medium text-zinc-200">{appName}{text.separator}{text.meetingDetails}</div>
          <div className="text-[11px] text-zinc-500">
            {audioSegs.length}{text.units.speechSegmentSuffix}{text.separator}{formatDurationShort(totalDuration, text.duration)}
            {speakerIds.length > 0 && `${text.separator}${speakerIds.length}${text.units.speakerCountSuffix}`}
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
              <div className="text-[10px] text-zinc-600 mb-1.5">{text.speaker}</div>
              <div className="space-y-1">
                {speakerIds.map((id) => {
                  const style = speakerStyle(id);
                  return (
                    <div key={id} className="flex items-center gap-1.5">
                      <div className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
                      <span className={`text-[11px] ${style.text}`}>{text.speaker} {id}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Topic list */}
          <div className="px-2 space-y-0.5">
            {topics.map((topic, idx) => (
              <button /* ds-allow:button: 话题列表项，全宽左对齐多行内容+选中态边框，primitive 居中变体不兼容 */
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
                  {topic.segments.length}{text.units.segmentSuffix}
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
                          {text.speaker}{spkId}
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
  meetingAppNames: Set<string>;
  text: NativeDesktopText;
  onToggle: () => void;
  onScreenshotClick: (path: string) => void;
  onOpenMeeting?: () => void;
}> = ({ cluster, audioSegs, expanded, meetingAppNames, text, onToggle, onScreenshotClick, onOpenMeeting }) => {
  const isMeeting = meetingAppNames.has(cluster.appName);
  const allEvents = cluster.segments.flatMap((s) => s.events);
  const allScreenshots = allEvents.filter(
    (e): e is DesktopActivityEvent & { screenshotPath: string } => Boolean(e.screenshotPath),
  );
  const allAnalyses = allEvents
    .filter((e): e is DesktopActivityEvent & { analyzeText: string } => Boolean(e.analyzeText))
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
      <button /* ds-allow:button: 应用分组卡片头，全宽可展开行，自定义布局，primitive 变体不兼容 */
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
              <span className="ml-2 text-[10px] text-amber-400 font-normal">{text.meetingRecordPrefix}{audioSegs.length}{text.units.segmentSuffix}</span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500">
            {formatDurationShort(cluster.totalDurationMs, text.duration)}{text.separator}{cluster.eventCount}{text.units.recordSuffix}
            {allScreenshots.length > 0 && `${text.separator}${allScreenshots.length}${text.units.screenshotSuffix}`}
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
                  path={ev.screenshotPath}
                  className={`${allScreenshots.length === 1 ? 'w-full h-44' : 'w-52 h-32 shrink-0'} rounded-lg`}
                  onClick={() => onScreenshotClick(ev.screenshotPath)}
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
                    {audioSegs.length}{text.units.speechSegmentSuffix}
                    {(() => {
                      const ids = new Set(audioSegs.filter((s) => s.speaker_id && s.speaker_id > 0).map((s) => s.speaker_id));
                      return ids.size > 0 ? `${text.separator}${ids.size}${text.units.speakerCountSuffix}` : '';
                    })()}
                    {audioSegs.length >= 2 && `${text.separator}${formatDurationShort(audioSegs[audioSegs.length - 1].end_at_ms - audioSegs[0].start_at_ms, text.duration)}`}
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
                          <span className={`shrink-0 ${style.text}`}>{text.speaker}{spkId}:</span>
                        )}
                        <span className="text-zinc-400 line-clamp-1">{seg.transcript}</span>
                      </div>
                    );
                  })}
                  {audioSegs.length > 3 && (
                    <div className="text-[11px] text-zinc-600">{text.moreSegmentsPrefix}{audioSegs.length - 3}{text.units.segmentSuffix}</div>
                  )}
                </div>
                {/* Detail entry button */}
                <button /* ds-allow:button: 查看会议详情入口，amber 语义色描边胶囊，primitive 无对应变体 */
                  onClick={onOpenMeeting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[12px] hover:bg-amber-500/20 transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  {text.viewMeetingDetails}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const HourDetailPanel: React.FC<{
  block: HourBlock;
  date: Date;
  meetingAppNames: Set<string>;
  text: NativeDesktopText;
}> = ({ block, date, meetingAppNames, text }) => {
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);
  const [audioSegs, setAudioSegs] = useState<AudioSegment[]>([]);
  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(new Set());
  const [meetingDetailApp, setMeetingDetailApp] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const appGroupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Load audio segments for this hour (with periodic refresh)
  useEffect(() => {
    const load = () => {
      const dayStart = new Date(date);
      dayStart.setHours(block.hour, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(block.hour, 59, 59, 999);
      listAudioSegments(dayStart.getTime(), dayEnd.getTime()).then(setAudioSegs);
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
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
          <div className="text-sm">{text.emptyHour}</div>
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
            {block.eventCount}{text.units.recordSuffix}{text.separator}{appSet.size}{text.units.appSuffix}
          </span>
        </div>

        {/* Clickable app chips — scroll to group */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {appClusters.map((cluster) => (
            <button /* ds-allow:button: 应用 chip 胶囊（rounded-full+应用色点），primitive 无对应变体 */
              key={cluster.appName}
              onClick={() => scrollToApp(cluster.appName)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/60 border border-zinc-700/40 hover:bg-zinc-700/60 hover:border-zinc-600/60 transition-colors"
            >
              <div className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] font-medium ${appColor(cluster.appName)}`}>
                {appInitial(cluster.appName)}
              </div>
              <span className="text-[11px] text-zinc-300">{cluster.appName}</span>
              <span className="text-[10px] text-zinc-500">
                {formatDurationShort(cluster.totalDurationMs, text.duration)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Audio segments (standalone — always show if present) */}
      {audioSegs.length > 0 && (
        <div className="px-5 pt-4 pb-2">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-amber-500/10">
              <Mic className="w-4 h-4 text-amber-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-zinc-200">{text.audioRecords}</div>
                <div className="text-[11px] text-zinc-500">
                  {audioSegs.length}{text.units.speechSegmentSuffix}{text.separator}{audioSegs.length >= 2
                    ? formatDurationShort(audioSegs[audioSegs.length - 1].end_at_ms - audioSegs[0].start_at_ms, text.duration)
                    : formatDurationShort(audioSegs[0].duration_ms, text.duration)}
                </div>
              </div>
            </div>
            <div className="px-4 py-3 space-y-1.5 max-h-[300px] overflow-y-auto">
              {[...audioSegs].reverse().map((seg) => (
                <div key={seg.id} className="flex gap-2.5 text-[12px]">
                  <span className="text-zinc-600 font-mono shrink-0 w-11 text-right pt-px">
                    {formatTime(seg.start_at_ms)}
                  </span>
                  <span className="text-zinc-300 leading-relaxed">
                    {seg.transcript || <span className="text-zinc-600 italic">{text.transcribing}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Visual analysis summary (standalone — always show if present) */}
      {(() => {
        const allAnalyses = block.segments
          .flatMap((s) => s.events)
          .filter((e): e is DesktopActivityEvent & { analyzeText: string } => Boolean(e.analyzeText))
          .sort((a, b) => b.capturedAtMs - a.capturedAtMs);
        if (allAnalyses.length === 0) return null;
        return (
          <div className="px-5 pt-4 pb-2">
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 overflow-hidden">
              <div className="flex items-center gap-2.5 px-4 py-3 border-b border-cyan-500/10">
                <Eye className="w-4 h-4 text-cyan-400" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-200">{text.visualAnalysis}</div>
                  <div className="text-[11px] text-zinc-500">
                    {allAnalyses.length}{text.units.analysisSuffix}{text.separator}{new Set(allAnalyses.map(e => e.appName)).size}{text.units.appSuffix}
                  </div>
                </div>
              </div>
              <div className="px-4 py-3 space-y-3 max-h-[400px] overflow-y-auto">
                {allAnalyses.map((ev, idx) => (
                  <div key={ev.id || idx} className="space-y-1">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-zinc-600 font-mono">{formatTime(ev.capturedAtMs)}</span>
                      <span className="text-zinc-500">{ev.appName}</span>
                      {ev.windowTitle && <span className="text-zinc-600 truncate max-w-[200px]">{ev.windowTitle}</span>}
                    </div>
                    <div className="text-[12px] text-zinc-400 leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-1 prose-ul:my-0.5 prose-li:my-0 prose-strong:text-zinc-300">
                      <ReactMarkdown>{formatAnalysisText(ev.analyzeText)}</ReactMarkdown>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* App groups */}
      <div className="px-5 py-4 space-y-3">
        {appClusters.map((cluster) => {
          const isMeeting = meetingAppNames.has(cluster.appName);
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
                meetingAppNames={meetingAppNames}
                text={text}
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
          text={text}
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

export const NativeDesktopSection: React.FC<NativeDesktopSectionProps> = ({
  onClose,
  variant = 'embedded',
}) => {
  const { t } = useI18n();
  const nativeDesktopText = t.settings.nativeDesktop;
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

  const [audioCaptureMode, setAudioCaptureMode] = useState<'microphone' | 'system-audio'>('system-audio');

  const handleToggleAudio = async () => {
    setAudioBusy(true);
    setError(null);
    try {
      const result = audioStatus?.capturing
        ? await stopAudioCapture()
        : await startAudioCapture(audioCaptureMode);
      setAudioStatus(result);
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
  const meetingAppNames = useMemo(
    () => buildMeetingAppNameSet(nativeDesktopText.meetingAppNames),
    [nativeDesktopText.meetingAppNames],
  );

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
  const fullscreen = variant === 'fullscreen';

  return (
    <div className={`flex flex-col h-full ${fullscreen ? 'bg-zinc-950 text-zinc-100' : ''}`}>
      {/* Header */}
      <div className={`flex items-center justify-between border-b shrink-0 ${
        fullscreen
          ? 'h-14 border-zinc-800 bg-zinc-950/95 px-5'
          : 'border-zinc-700/50 px-4 py-2.5'
      }`}>
        <div className="flex items-center gap-2.5">
          <Monitor className="w-4 h-4 text-cyan-400" />
          <span className={fullscreen ? 'text-base font-semibold text-zinc-100' : 'text-sm font-medium text-zinc-200'}>
            {nativeDesktopText.title}
          </span>
          <div className={`px-1.5 py-0.5 rounded-full text-[10px] ${
            collectorStatus?.running
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-zinc-700/40 text-zinc-500 border border-zinc-600/30'
          }`}>
            {collectorStatus?.running ? nativeDesktopText.status.collecting : nativeDesktopText.status.stopped}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button /* ds-allow:button: 日期前翻图标按钮 p-0.5，primitive 变体会改变尺寸 */ onClick={() => navigateDate(-1)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] text-zinc-400 w-[110px] text-center">{formatDate(currentDate, nativeDesktopText.date)}</span>
            <button /* ds-allow:button: 日期后翻图标按钮 p-0.5，primitive 变体会改变尺寸 */ onClick={() => navigateDate(1)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 采集模式切换（非录音状态时可切换） */}
          {!audioStatus?.capturing && (
            <button /* ds-allow:button: 采集模式切换，自定义小尺寸 chip+图标随状态切换，primitive 无对应变体 */
              onClick={() => setAudioCaptureMode(m => m === 'microphone' ? 'system-audio' : 'microphone')}
              title={audioCaptureMode === 'system-audio' ? nativeDesktopText.audioMode.systemAudioTitle : nativeDesktopText.audioMode.microphone}
              className="px-2 py-1 rounded-lg text-[11px] inline-flex items-center gap-1 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 border border-zinc-700/50 transition-colors"
            >
              {audioCaptureMode === 'system-audio' ? (
                <><Volume2 className="w-3 h-3" /> {nativeDesktopText.audioMode.systemAudio}</>
              ) : (
                <><Mic className="w-3 h-3" /> {nativeDesktopText.audioMode.microphone}</>
              )}
            </button>
          )}

          <button /* ds-allow:button: 录音开关，状态色（录音中 rose+pulse / 默认 zinc）小尺寸 chip，primitive 无对应变体 */
            onClick={handleToggleAudio}
            disabled={audioBusy}
            title={audioStatus?.capturing
              ? nativeDesktopText.recording.stopTitle
              : audioCaptureMode === 'system-audio'
                ? nativeDesktopText.recording.systemAudioTitle
                : nativeDesktopText.recording.microphoneTitle}
            className={`px-2.5 py-1 rounded-lg text-[11px] inline-flex items-center gap-1 transition-colors ${
              audioStatus?.capturing
                ? 'bg-rose-600/80 text-white hover:bg-rose-500 animate-pulse'
                : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
            } disabled:opacity-50`}
          >
            {audioStatus?.capturing ? (
              <><MicOff className="w-3 h-3" /> {nativeDesktopText.recording.recording}</>
            ) : (
              <><Mic className="w-3 h-3" /> {nativeDesktopText.recording.record}</>
            )}
          </button>

          <button /* ds-allow:button: 采集开关，状态色（采集中 zinc / 默认 cyan）小尺寸 chip，primitive 无对应变体 */
            onClick={handleToggleCollector}
            disabled={collectorBusy}
            className={`px-2.5 py-1 rounded-lg text-[11px] inline-flex items-center gap-1 transition-colors ${
              collectorStatus?.running
                ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                : 'bg-cyan-600 text-white hover:bg-cyan-500'
            } disabled:opacity-50`}
          >
            {collectorStatus?.running ? (
              <><Square className="w-3 h-3" /> {nativeDesktopText.collector.stop}</>
            ) : (
              <><Play className="w-3 h-3" /> {nativeDesktopText.collector.collect}</>
            )}
          </button>

          {onClose ? (
            <button /* ds-allow:button: 面板关闭按钮，方形图标按钮（h-8 w-8），primitive 变体会改变外观 */
              type="button"
              onClick={onClose}
              aria-label={nativeDesktopText.closeCaptureAria}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
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
          <span>{totalEvents}{nativeDesktopText.units.recordSuffix}</span>
          <span>{appCount}{nativeDesktopText.units.appSuffix}</span>
          {screenshotCount > 0 && <span>{screenshotCount}{nativeDesktopText.units.screenshotSuffix}</span>}
          {analyzedCount > 0 && <span>{analyzedCount}{nativeDesktopText.units.aiAnalysisSuffix}</span>}
          {audioStatus?.capturing && (
            <span className="text-rose-400">
              {nativeDesktopText.recording.recording}{nativeDesktopText.separator}{audioStatus.totalSegments}{nativeDesktopText.units.segmentSuffix}{nativeDesktopText.separator}{audioStatus.asrEngine}
              {audioStatus.captureMode === 'system-audio' ? `${nativeDesktopText.separator}${nativeDesktopText.audioMode.systemAudio}` : ''}
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
            <div className="flex items-center justify-center h-full text-xs text-zinc-500">{nativeDesktopText.loading}</div>
          ) : (
            <HourDetailPanel
              block={selectedBlock}
              date={currentDate}
              meetingAppNames={meetingAppNames}
              text={nativeDesktopText}
            />
          )}
        </div>
      </div>
    </div>
  );
};
