// ============================================================================
// NativeDesktopSection - 桌面活动时间线（StepFun 全局记忆风格）
// 左侧活动时间线 + 右侧详情面板
// ============================================================================

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Play,
  Square,
  Monitor,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
} from 'lucide-react';
import {
  getNativeDesktopCollectorStatus,
  listRecentNativeDesktopEvents,
  startNativeDesktopCollector,
  stopNativeDesktopCollector,
  type DesktopActivityEvent,
  type NativeDesktopCollectorStatus,
} from '../../../../services/nativeDesktop';

// ============================================================================
// Types
// ============================================================================

interface ActivitySegment {
  appName: string;
  bundleId?: string | null;
  startMs: number;
  endMs: number;
  events: DesktopActivityEvent[];
  title: string; // derived from most common windowTitle
}

// ============================================================================
// Helpers
// ============================================================================

function groupEventsIntoSegments(events: DesktopActivityEvent[]): ActivitySegment[] {
  if (events.length === 0) return [];

  // Sort by time ascending
  const sorted = [...events].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  const segments: ActivitySegment[] = [];
  let current: ActivitySegment | null = null;

  for (const event of sorted) {
    // Same app and within 10 minutes gap → merge into segment
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
        bundleId: event.bundleId,
        startMs: event.capturedAtMs,
        endMs: event.capturedAtMs,
        events: [event],
        title: '',
      };
      segments.push(current);
    }
  }

  // Derive title from most common windowTitle in each segment
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

  // Reverse so newest first
  return segments.reverse();
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatTimeRange(startMs: number, endMs: number): string {
  if (startMs === endMs) return formatTime(startMs);
  return `${formatTime(startMs)} - ${formatTime(endMs)}`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${y}-${m}-${d} ${weekdays[date.getDay()]}`;
}

function durationText(startMs: number, endMs: number): string {
  const diffMin = Math.round((endMs - startMs) / 60000);
  if (diffMin < 1) return '< 1 分钟';
  if (diffMin < 60) return `${diffMin} 分钟`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

// Generate a deterministic color from app name
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
  // Get first meaningful character
  const clean = appName.replace(/\.app$/, '').trim();
  return clean.charAt(0).toUpperCase();
}

// ============================================================================
// Screenshot component (loads via file:// or asset protocol)
// ============================================================================

const ScreenshotImage: React.FC<{ path: string; className?: string }> = ({ path, className }) => {
  const [error, setError] = useState(false);

  if (error || !path) {
    return (
      <div className={`flex items-center justify-center bg-zinc-800 text-zinc-600 ${className || ''}`}>
        <ImageIcon className="w-8 h-8" />
      </div>
    );
  }

  // Convert local path to file:// URL for Tauri/web
  const src = path.startsWith('file://') ? path : `file://${path}`;

  return (
    <img
      src={src}
      alt="Screenshot"
      className={`object-cover ${className || ''}`}
      onError={() => setError(true)}
    />
  );
};

// ============================================================================
// Component
// ============================================================================

export const NativeDesktopSection: React.FC = () => {
  const [collectorStatus, setCollectorStatus] = useState<NativeDesktopCollectorStatus | null>(null);
  const [recentEvents, setRecentEvents] = useState<DesktopActivityEvent[]>([]);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collectorBusy, setCollectorBusy] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());

  // Group events into activity segments
  const segments = useMemo(() => groupEventsIntoSegments(recentEvents), [recentEvents]);
  const loadData = useCallback(async () => {
    try {
      const [status, events] = await Promise.all([
        getNativeDesktopCollectorStatus(),
        listRecentNativeDesktopEvents(50),
      ]);
      setCollectorStatus(status);
      setRecentEvents(events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh when collector is running
  useEffect(() => {
    if (!collectorStatus?.running) return;
    const timer = window.setInterval(() => {
      loadData();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [collectorStatus?.running, loadData]);

  const handleToggleCollector = async () => {
    setCollectorBusy(true);
    setError(null);
    try {
      if (collectorStatus?.running) {
        const status = await stopNativeDesktopCollector();
        setCollectorStatus(status);
      } else {
        const status = await startNativeDesktopCollector({
          intervalSecs: 30,
          captureScreenshots: true,
          redactSensitiveContexts: true,
          retentionDays: 7,
          dedupeWindowSecs: 60,
          maxRecentEvents: 50,
        });
        setCollectorStatus(status);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollectorBusy(false);
    }
  };

  const navigateDate = (delta: number) => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + delta);
    setCurrentDate(d);
    // TODO: load events for specific date from SQLite
  };

  // Filter segments to current date
  const filteredSegments = useMemo(() => {
    const dayStart = new Date(currentDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(23, 59, 59, 999);
    return segments.filter(
      (s) => s.startMs >= dayStart.getTime() && s.startMs <= dayEnd.getTime()
    );
  }, [segments, currentDate]);

  const displaySegment = filteredSegments[selectedSegmentIndex] || null;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: collector controls */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/50">
        <div className="flex items-center gap-3">
          <Monitor className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-medium text-zinc-200">桌面活动</span>
          <div className={`px-2 py-0.5 rounded-full text-[11px] ${
            collectorStatus?.running
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-zinc-700/40 text-zinc-500 border border-zinc-600/30'
          }`}>
            {collectorStatus?.running ? '采集中' : '已停止'}
          </div>
          {collectorStatus?.running && (
            <span className="text-[11px] text-zinc-500">
              已采集 {collectorStatus.totalEventsWritten} 条
            </span>
          )}
        </div>

        <button
          onClick={handleToggleCollector}
          disabled={collectorBusy}
          className={`px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 transition-colors ${
            collectorStatus?.running
              ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
              : 'bg-cyan-600 text-white hover:bg-cyan-500'
          } disabled:opacity-50`}
        >
          {collectorStatus?.running ? (
            <><Square className="w-3 h-3" /> 停止</>
          ) : (
            <><Play className="w-3 h-3" /> 启动采集</>
          )}
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-2 p-2 rounded-lg border border-rose-500/20 bg-rose-500/10 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* Date navigation */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-700/30">
        <button
          onClick={() => navigateDate(-1)}
          className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs text-zinc-400">{formatDate(currentDate)}</span>
        <button
          onClick={() => navigateDate(1)}
          className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Main content: two-column layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left: activity timeline */}
        <div className="w-[280px] border-r border-zinc-700/30 overflow-y-auto">
          {loading && filteredSegments.length === 0 && (
            <div className="p-4 text-xs text-zinc-500 text-center">加载中...</div>
          )}

          {!loading && filteredSegments.length === 0 && (
            <div className="p-6 text-center">
              <Monitor className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
              <div className="text-xs text-zinc-500">
                {collectorStatus?.running ? '等待活动数据...' : '启动采集以记录桌面活动'}
              </div>
            </div>
          )}

          {filteredSegments.map((segment, index) => (
            <button
              key={`${segment.appName}-${segment.startMs}`}
              onClick={() => setSelectedSegmentIndex(index)}
              className={`w-full text-left px-4 py-3 border-b border-zinc-800/50 transition-colors ${
                selectedSegmentIndex === index
                  ? 'bg-zinc-700/50'
                  : 'hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-start gap-3">
                {/* App icon placeholder */}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-medium shrink-0 mt-0.5 ${appColor(segment.appName)}`}>
                  {appInitial(segment.appName)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-200 truncate">
                    {segment.title}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    {segment.appName}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-2">
                    <span>{formatTimeRange(segment.startMs, segment.endMs)}</span>
                    {segment.events.length > 1 && (
                      <span className="text-zinc-600">
                        {durationText(segment.startMs, segment.endMs)}
                      </span>
                    )}
                  </div>
                </div>
                {/* Screenshot indicator */}
                {segment.events.some((e) => e.screenshotPath) && (
                  <ImageIcon className="w-3 h-3 text-zinc-600 shrink-0 mt-1" />
                )}
              </div>
            </button>
          ))}

          {/* Daily summary */}
          {filteredSegments.length > 0 && (
            <div className="px-4 py-3 text-[11px] text-zinc-600 border-t border-zinc-800/50">
              今日共 {filteredSegments.length} 个活动片段，
              涉及 {new Set(filteredSegments.map((s) => s.appName)).size} 个应用
            </div>
          )}
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 overflow-y-auto">
          {displaySegment ? (
            <div className="p-5 space-y-4">
              {/* Header */}
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg font-medium ${appColor(displaySegment.appName)}`}>
                  {appInitial(displaySegment.appName)}
                </div>
                <div>
                  <h3 className="text-base font-medium text-zinc-200">
                    {displaySegment.title}
                  </h3>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {displaySegment.appName} · {formatTimeRange(displaySegment.startMs, displaySegment.endMs)}
                    {displaySegment.events.length > 1 && ` · ${durationText(displaySegment.startMs, displaySegment.endMs)}`}
                  </div>
                </div>
              </div>

              {/* Screenshot preview */}
              {(() => {
                const screenshotEvent = displaySegment.events.find((e) => e.screenshotPath);
                if (!screenshotEvent?.screenshotPath) return null;
                return (
                  <div className="rounded-lg overflow-hidden border border-zinc-700/50">
                    <ScreenshotImage
                      path={screenshotEvent.screenshotPath}
                      className="w-full h-auto max-h-[300px] rounded-lg"
                    />
                  </div>
                );
              })()}

              {/* Description - prefer analyzeText from vision analysis */}
              {(() => {
                // Find the first event with analyzeText
                const analyzed = displaySegment.events.find((e) => e.analyzeText);
                if (analyzed?.analyzeText) {
                  return (
                    <div className="text-sm text-zinc-300 leading-relaxed">
                      {analyzed.analyzeText}
                    </div>
                  );
                }
                return (
                  <div className="text-sm text-zinc-400 leading-relaxed">
                    在 <span className="text-zinc-200">{displaySegment.appName}</span> 中
                    {displaySegment.events[0]?.browserUrl
                      ? `浏览了 ${displaySegment.events[0].browserUrl}`
                      : displaySegment.events[0]?.documentPath
                        ? `编辑了 ${displaySegment.events[0].documentPath}`
                        : `使用了「${displaySegment.title}」`
                    }
                    {displaySegment.events.length > 1 && `，共记录 ${displaySegment.events.length} 个活动点`}。
                  </div>
                );
              })()}

              {/* Action timeline */}
              <div>
                <h4 className="text-xs font-medium text-zinc-400 mb-3">行动时间线</h4>
                <div className="space-y-0">
                  {displaySegment.events.map((event, i) => (
                    <div key={event.id} className="flex items-start gap-3 relative">
                      {/* Timeline line */}
                      <div className="flex flex-col items-center">
                        <div className="w-2 h-2 rounded-full bg-zinc-600 mt-1.5 shrink-0" />
                        {i < displaySegment.events.length - 1 && (
                          <div className="w-px flex-1 bg-zinc-700/50 min-h-[24px]" />
                        )}
                      </div>
                      {/* Event content */}
                      <div className="pb-3 min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[11px] text-zinc-500 font-mono shrink-0">
                            {formatTime(event.capturedAtMs)}
                          </span>
                          <span className="text-xs text-zinc-300 truncate">
                            {event.windowTitle || event.browserTitle || event.appName}
                          </span>
                        </div>
                        {event.browserUrl && (
                          <div className="text-[11px] text-zinc-600 truncate mt-0.5 pl-[52px]">
                            {event.browserUrl}
                          </div>
                        )}
                        {event.documentPath && (
                          <div className="text-[11px] text-zinc-600 truncate mt-0.5 pl-[52px]">
                            {event.documentPath}
                          </div>
                        )}
                        {event.analyzeText && (
                          <div className="text-[11px] text-zinc-400 mt-1 pl-[52px] line-clamp-2">
                            {event.analyzeText}
                          </div>
                        )}
                      </div>
                      {/* Mini screenshot */}
                      {event.screenshotPath && (
                        <div className="w-12 h-8 rounded overflow-hidden border border-zinc-700/50 shrink-0 mt-0.5">
                          <ScreenshotImage
                            path={event.screenshotPath}
                            className="w-full h-full"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-600">
              <div className="text-center">
                <Monitor className="w-10 h-10 mx-auto mb-2 text-zinc-700" />
                <div className="text-sm">选择左侧活动查看详情</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
