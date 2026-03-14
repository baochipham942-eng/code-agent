import React, { useEffect, useState } from 'react';
import {
  Camera,
  Clock,
  Database,
  ExternalLink,
  Monitor,
  Play,
  RefreshCw,
  Shield,
  Square,
} from 'lucide-react';
import {
  captureNativeDesktopScreenshot,
  getFrontmostDesktopContext,
  getNativeDesktopCapabilities,
  getNativeDesktopCollectorStatus,
  getNativeDesktopPermissionStatus,
  listRecentNativeDesktopEvents,
  openNativeDesktopSystemSettings,
  startNativeDesktopCollector,
  stopNativeDesktopCollector,
  type DesktopActivityEvent,
  type FrontmostContextSnapshot,
  type NativeDesktopCapabilities,
  type NativeDesktopCollectorStatus,
  type NativePermissionSnapshot,
  type NativePermissionStatus,
  type ScreenshotCaptureResult,
} from '../../../../services/nativeDesktop';

function statusPill(permission: NativePermissionStatus): string {
  switch (permission.status) {
    case 'granted':
      return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    case 'denied':
      return 'bg-rose-500/10 text-rose-300 border-rose-500/20';
    case 'unsupported':
      return 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40';
    default:
      return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  }
}

function formatTimestamp(timestamp?: number | null): string {
  if (!timestamp) return '未采集';
  return new Date(timestamp).toLocaleString();
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const NativeDesktopSection: React.FC = () => {
  const [capabilities, setCapabilities] = useState<NativeDesktopCapabilities | null>(null);
  const [permissions, setPermissions] = useState<NativePermissionSnapshot | null>(null);
  const [context, setContext] = useState<FrontmostContextSnapshot | null>(null);
  const [screenshot, setScreenshot] = useState<ScreenshotCaptureResult | null>(null);
  const [collectorStatus, setCollectorStatus] = useState<NativeDesktopCollectorStatus | null>(null);
  const [recentEvents, setRecentEvents] = useState<DesktopActivityEvent[]>([]);
  const [collectorIntervalSecs, setCollectorIntervalSecs] = useState(30);
  const [collectorCaptureScreenshots, setCollectorCaptureScreenshots] = useState(true);
  const [collectorRedactSensitive, setCollectorRedactSensitive] = useState(true);
  const [collectorRetentionDays, setCollectorRetentionDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [collectorBusy, setCollectorBusy] = useState(false);

  const loadSnapshot = async () => {
    setLoading(true);
    setError(null);

    const results = await Promise.allSettled([
      getNativeDesktopCapabilities(),
      getNativeDesktopPermissionStatus(),
      getFrontmostDesktopContext(),
      getNativeDesktopCollectorStatus(),
      listRecentNativeDesktopEvents(8),
    ]);

    const [capabilitiesResult, permissionsResult, contextResult, collectorStatusResult, recentEventsResult] = results;
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
      .filter(Boolean);

    if (capabilitiesResult.status === 'fulfilled') {
      setCapabilities(capabilitiesResult.value);
    }
    if (permissionsResult.status === 'fulfilled') {
      setPermissions(permissionsResult.value);
    }
    if (contextResult.status === 'fulfilled') {
      setContext(contextResult.value);
    }
    if (collectorStatusResult.status === 'fulfilled') {
      setCollectorStatus(collectorStatusResult.value);
      setCollectorIntervalSecs(collectorStatusResult.value.intervalSecs || 30);
      setCollectorCaptureScreenshots(collectorStatusResult.value.captureScreenshots);
      setCollectorRedactSensitive(collectorStatusResult.value.redactSensitiveContexts ?? true);
      setCollectorRetentionDays(collectorStatusResult.value.retentionDays || 7);
    }
    if (recentEventsResult.status === 'fulfilled') {
      setRecentEvents(recentEventsResult.value);
    }

    setError(errors.length > 0 ? errors[0] : null);
    setLoading(false);
  };

  useEffect(() => {
    loadSnapshot().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!collectorStatus?.running) return;

    const timer = window.setInterval(() => {
      loadSnapshot().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [collectorStatus?.running]);

  const handleCapture = async () => {
    setCapturing(true);
    setError(null);
    try {
      const result = await captureNativeDesktopScreenshot();
      setScreenshot(result);
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  };

  const handleStartCollector = async () => {
    setCollectorBusy(true);
    setError(null);
    try {
      const status = await startNativeDesktopCollector({
        intervalSecs: Math.max(5, collectorIntervalSecs || 30),
        captureScreenshots: collectorCaptureScreenshots,
        redactSensitiveContexts: collectorRedactSensitive,
        retentionDays: Math.max(1, collectorRetentionDays || 7),
        dedupeWindowSecs: 60,
        maxRecentEvents: 20,
      });
      setCollectorStatus(status);
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollectorBusy(false);
    }
  };

  const handleStopCollector = async () => {
    setCollectorBusy(true);
    setError(null);
    try {
      const status = await stopNativeDesktopCollector();
      setCollectorStatus(status);
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollectorBusy(false);
    }
  };

  return (
    <div className="pt-4 border-t border-zinc-700 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
            <Monitor className="w-4 h-4" />
            原生桌面底座
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            P1 已经从单次快照进到后台 collector：持续轮询、去重、文件/会话/电源上下文采集，JSONL + SQLite 落盘。
          </p>
        </div>
        <button
          onClick={() => loadSnapshot()}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-rose-500/20 bg-rose-500/10 text-xs text-rose-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800/60">
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Capabilities</div>
          <div className="space-y-1.5 text-sm text-zinc-300">
            <div>Platform: <span className="text-zinc-100">{capabilities?.platform || 'unknown'}</span></div>
            <div>Phase: <span className="text-zinc-100">{capabilities?.phase || 'unknown'}</span></div>
            <div>Frontmost context: <span className="text-zinc-100">{capabilities?.supportsFrontmostContext ? 'yes' : 'no'}</span></div>
            <div>Browser context: <span className="text-zinc-100">{capabilities?.supportsBrowserContext ? 'yes' : 'no'}</span></div>
            <div>Background collection: <span className="text-zinc-100">{capabilities?.supportsBackgroundCollection ? 'yes' : 'not yet'}</span></div>
          </div>
        </div>

        <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800/60">
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Latest Context</div>
          <div className="space-y-1.5 text-sm text-zinc-300">
            <div>Captured: <span className="text-zinc-100">{formatTimestamp(context?.capturedAtMs)}</span></div>
            <div>App: <span className="text-zinc-100">{context?.appName || 'unknown'}</span></div>
            <div>Window: <span className="text-zinc-100 break-all">{context?.windowTitle || 'N/A'}</span></div>
            <div>URL: <span className="text-zinc-100 break-all">{context?.browserUrl || 'N/A'}</span></div>
            <div>Document: <span className="text-zinc-100 break-all">{context?.documentPath || 'N/A'}</span></div>
            <div>Session: <span className="text-zinc-100">{context?.sessionState || 'N/A'}</span></div>
            <div>
              Power: <span className="text-zinc-100">
                {context?.powerSource || 'N/A'}
                {typeof context?.batteryPercent === 'number' ? ` ${context.batteryPercent}%` : ''}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800/60">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Permissions</div>
          <div className="text-xs text-zinc-500">
            Last checked: {formatTimestamp(permissions?.checkedAtMs)}
          </div>
        </div>

        <div className="space-y-2">
          {(permissions?.permissions || []).map((permission: NativePermissionStatus) => (
            <div
              key={permission.kind}
              className="flex items-start justify-between gap-3 p-2 rounded-lg border border-zinc-700/80 bg-zinc-900/40"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="text-sm text-zinc-200">{permission.kind}</span>
                  <span className={`px-2 py-0.5 rounded-full border text-[11px] ${statusPill(permission)}`}>
                    {permission.status}
                  </span>
                </div>
                {permission.detail && (
                  <div className="mt-1 text-xs text-zinc-500 break-all">{permission.detail}</div>
                )}
              </div>

              {(permission.kind === 'screenCapture' || permission.kind === 'accessibility') && permission.status !== 'granted' && (
                <button
                  onClick={() => openNativeDesktopSystemSettings(permission.kind as 'screenCapture' | 'accessibility')}
                  className="shrink-0 px-2.5 py-1 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1.5"
                >
                  <ExternalLink className="w-3 h-3" />
                  打开设置
                </button>
              )}
            </div>
          ))}

          {!permissions && !loading && (
            <div className="text-xs text-zinc-500">暂无权限状态。</div>
          )}
        </div>
      </div>

      <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800/60 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Background Collector</div>
            <div className="text-xs text-zinc-500 mt-1">
              原生层定时采集前台应用、窗口标题、浏览器 URL、文件路径、会话状态和电源状态，并按时间写入本地事件日志。
            </div>
          </div>
          <div className={`px-2.5 py-1 rounded-full border text-[11px] ${
            collectorStatus?.running
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              : 'border-zinc-700 bg-zinc-900/60 text-zinc-400'
          }`}>
            {collectorStatus?.running ? 'running' : 'stopped'}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40">
            <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Interval
            </div>
            <input
              type="number"
              min={5}
              step={5}
              value={collectorIntervalSecs}
              onChange={(event) => setCollectorIntervalSecs(Number(event.target.value || 30))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <div className="mt-1 text-xs text-zinc-500">单位：秒，最小 5 秒。</div>
          </label>

          <label className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={collectorCaptureScreenshots}
              onChange={(event) => setCollectorCaptureScreenshots(event.target.checked)}
              className="mt-1"
            />
            <div>
              <div className="text-sm text-zinc-200">Capture screenshots</div>
              <div className="text-xs text-zinc-500 mt-1">
                开启后每次落盘事件都会尝试保存一张系统截图。没有屏幕权限时会自动降级成元数据采集。
              </div>
            </div>
          </label>

          <label className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={collectorRedactSensitive}
              onChange={(event) => setCollectorRedactSensitive(event.target.checked)}
              className="mt-1"
            />
            <div>
              <div className="text-sm text-zinc-200">Redact sensitive contexts</div>
              <div className="text-xs text-zinc-500 mt-1">
                对密码管理器、验证码等敏感窗口自动脱敏，并跳过截图落盘。
              </div>
            </div>
          </label>

          <label className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40">
            <div className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5" />
              Retention days
            </div>
            <input
              type="number"
              min={1}
              max={90}
              step={1}
              value={collectorRetentionDays}
              onChange={(event) => setCollectorRetentionDays(Number(event.target.value || 7))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <div className="mt-1 text-xs text-zinc-500">自动清理超期 JSONL、截图和 SQLite 记录。</div>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleStartCollector}
            disabled={collectorBusy}
            className="px-3 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Play className="w-3.5 h-3.5" />
            {collectorBusy ? '处理中...' : '启动采集'}
          </button>
          <button
            onClick={handleStopCollector}
            disabled={collectorBusy}
            className="px-3 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Square className="w-3.5 h-3.5" />
            停止采集
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-zinc-300">
          <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40 space-y-1.5">
            <div>Total events: <span className="text-zinc-100">{collectorStatus?.totalEventsWritten ?? 0}</span></div>
            <div>Last event: <span className="text-zinc-100">{formatTimestamp(collectorStatus?.lastEventAtMs)}</span></div>
            <div>Last cleanup: <span className="text-zinc-100">{formatTimestamp(collectorStatus?.lastCleanupAtMs)}</span></div>
            <div>Dedupe: <span className="text-zinc-100">{collectorStatus?.dedupeWindowSecs ?? 0}s</span></div>
            <div>Last error: <span className="text-zinc-100 break-all">{collectorStatus?.lastError || 'none'}</span></div>
          </div>
          <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40 space-y-1.5">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Database className="w-3.5 h-3.5" />
              Persisted paths
            </div>
            <div>Events: <span className="text-zinc-100 break-all">{collectorStatus?.eventDir || 'N/A'}</span></div>
            <div>Screenshots: <span className="text-zinc-100 break-all">{collectorStatus?.screenshotDir || 'N/A'}</span></div>
            <div>Current log: <span className="text-zinc-100 break-all">{collectorStatus?.eventsFile || 'N/A'}</span></div>
            <div>SQLite: <span className="text-zinc-100 break-all">{collectorStatus?.sqliteDbPath || 'N/A'}</span></div>
            <div>Retention: <span className="text-zinc-100">{collectorStatus?.retentionDays ?? collectorRetentionDays} days</span></div>
            <div>Privacy: <span className="text-zinc-100">{collectorStatus?.redactSensitiveContexts ? 'redact sensitive' : 'capture raw'}</span></div>
          </div>
        </div>
      </div>

      <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800/60 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Recent Events</div>
            <div className="text-xs text-zinc-500 mt-1">
              最近落盘的前台活动。这里就是后续时间线、日报、待办提取的原始输入。
            </div>
          </div>
          <div className="text-xs text-zinc-500">{recentEvents.length} items</div>
        </div>

        <div className="space-y-2">
          {recentEvents.map((event) => (
            <div
              key={event.id}
              className="p-3 rounded-lg border border-zinc-700 bg-zinc-900/40 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-zinc-100">{event.appName}</div>
                <div className="text-xs text-zinc-500">{formatTimestamp(event.capturedAtMs)}</div>
              </div>
              <div className="text-xs text-zinc-400 break-all">Window: {event.windowTitle || 'N/A'}</div>
              <div className="text-xs text-zinc-400 break-all">URL: {event.browserUrl || 'N/A'}</div>
              <div className="text-xs text-zinc-400 break-all">Document: {event.documentPath || 'N/A'}</div>
              <div className="text-xs text-zinc-400">Session: {event.sessionState || 'N/A'}</div>
              <div className="text-xs text-zinc-400">
                Power: {event.powerSource || 'N/A'}
                {typeof event.batteryPercent === 'number' ? ` ${event.batteryPercent}%` : ''}
              </div>
              <div className="text-xs text-zinc-400 break-all">Screenshot: {event.screenshotPath || 'none'}</div>
            </div>
          ))}

          {recentEvents.length === 0 && !loading && (
            <div className="text-xs text-zinc-500">暂无事件。启动 collector 后这里会开始累积。</div>
          )}
        </div>
      </div>

      <div className="p-3 rounded-lg border border-zinc-700 bg-zinc-800/60 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Native Screenshot</div>
            <div className="text-xs text-zinc-500 mt-1">
              直接调用系统截图能力，为 collector 和 GUI Agent 复用。
            </div>
          </div>
          <button
            onClick={handleCapture}
            disabled={capturing}
            className="px-3 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Camera className="w-3.5 h-3.5" />
            {capturing ? '截图中...' : '截一张'}
          </button>
        </div>

        <div className="text-sm text-zinc-300 space-y-1.5">
          <div>Latest file: <span className="text-zinc-100 break-all">{screenshot?.path || 'N/A'}</span></div>
          <div>Size: <span className="text-zinc-100">{formatBytes(screenshot?.bytes)}</span></div>
          <div>Captured: <span className="text-zinc-100">{formatTimestamp(screenshot?.capturedAtMs)}</span></div>
        </div>
      </div>
    </div>
  );
};
