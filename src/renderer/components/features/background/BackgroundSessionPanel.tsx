// ============================================================================
// Background Session Panel - 后台任务面板（composer 正上方的列内面板）
// ============================================================================
// 2026-10-11 rework：原 fixed bottom-4 right-4 浮层在常见窗宽下盖住发送键/模型切换/
// 上下文表（无槽验收实测 elementFromPoint(发送键中心)=面板本体）。改为 ChatView 列内、
// composer 正上方的文档流块（对齐 max-w-3xl 列右缘）——参与布局，几何上不可能再压
// composer 控件；模态遮罩仍在其上（floatingPanel 档）。

import React from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { Play, CheckCircle, XCircle, Loader2, X } from 'lucide-react';
import type { BackgroundSessionInfo } from '@shared/contract/sessionState';
import { Z_LAYERS } from '../../../styles/zLayers';
import { useI18n } from '../../../hooks/useI18n';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '@shared/constants';

interface BackgroundTaskLineLabels {
  completed: string;
  failed: string;
  cancelled: string;
  maxIterations: string;
}

/**
 * 条目状态行：running → 由组件渲染计时；终态 → 结果行。completionMessage 携带
 * 稳定 code（USER_CANCELLED / MAX_ITERATIONS_REACHED）时翻译成人话，其余原样展示
 * （engine 的终态消息），空则回落默认完成/失败行。
 */
function resolveBackgroundTaskStatusLine(
  session: Pick<BackgroundSessionInfo, 'status' | 'completionMessage'>,
  labels: BackgroundTaskLineLabels,
): { isRunning: boolean; line: string } {
  if (session.status === 'running') return { isRunning: true, line: '' };
  const message = session.completionMessage;
  if (message === BACKGROUND_TASK_CANCELLED) return { isRunning: false, line: labels.cancelled };
  if (message === RUN_ERROR_CODE_MAX_ITERATIONS) return { isRunning: false, line: labels.maxIterations };
  if (message) return { isRunning: false, line: message };
  return { isRunning: false, line: session.status === 'failed' ? labels.failed : labels.completed };
}

interface DurationLabels {
  seconds: string;
  minutes: string;
  hours: string;
}

function formatBackgroundDuration(startedAt: number, now: number, labels: DurationLabels): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return labels.seconds.replace('{n}', String(seconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return labels.minutes.replace('{n}', String(minutes));
  return labels.hours.replace('{n}', String(Math.floor(minutes / 60))).replace('{m}', String(minutes % 60));
}

const BackgroundSessionItem: React.FC<{
  session: BackgroundSessionInfo;
  onForeground: () => void;
  line: string;
  foregroundAria: string;
}> = ({ session, onForeground, line, foregroundAria }) => {
  const statusIcon = {
    running: <Loader2 className="w-4 h-4 animate-spin text-badge-info" />,
    completed: <CheckCircle className="w-4 h-4 text-badge-success" />,
    failed: <XCircle className="w-4 h-4 text-badge-danger" />,
  }[session.status];

  return (
    <button
      onClick={onForeground}
      aria-label={foregroundAria}
      data-testid="background-session-item"
      data-status={session.status}
      className="w-full flex items-center gap-3 p-3 bg-zinc-700 hover:bg-zinc-600/80 rounded-lg transition-colors text-left"
    >
      {statusIcon}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-200 truncate">
          {session.title}
        </div>
        <div className="text-xs text-zinc-400" data-testid="background-session-item-line">
          {line}
        </div>
        {session.progress !== undefined && session.status === 'running' && (
          <div className="mt-1 h-1 bg-zinc-600 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${session.progress}%` }}
            />
          </div>
        )}
      </div>
      <Play className="w-4 h-4 text-zinc-500" />
    </button>
  );
};

export const BackgroundSessionPanel: React.FC = () => {
  const { backgroundSessions, moveToForeground } = useSessionStore();
  const { t } = useI18n();
  const [isMinimized, setIsMinimized] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  // running 条目的计时行每秒走一格；全部终态后停表（面板常驻不该空转定时器）。
  React.useEffect(() => {
    if (isMinimized || !backgroundSessions.some((s) => s.status === 'running')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isMinimized, backgroundSessions]);

  if (backgroundSessions.length === 0) {
    return null;
  }

  const durationLabels = {
    seconds: t.backgroundPanel.durationSeconds,
    minutes: t.backgroundPanel.durationMinutes,
    hours: t.backgroundPanel.durationHours,
  };
  const lineLabels = {
    completed: t.backgroundPanel.completedLine,
    failed: t.backgroundPanel.failedLine,
    cancelled: t.backgroundPanel.cancelledLine,
    maxIterations: t.backgroundPanel.maxIterationsLine,
  };

  if (isMinimized) {
    return (
      <div className="w-full shrink-0 chat-col-pad pb-1">
        <div className="mx-auto flex w-full max-w-3xl justify-end">
          <button
            onClick={() => setIsMinimized(false)}
            aria-label={t.backgroundPanel.minimizedAria}
            data-testid="background-session-panel-collapsed"
            className="flex items-center gap-2 px-3 py-2 bg-zinc-700 hover:bg-zinc-600/90 backdrop-blur-sm border border-zinc-700 rounded-full shadow-lg transition-colors"
            style={{ zIndex: Z_LAYERS.floatingPanel }}
          >
            <Loader2 className="w-4 h-4 animate-spin text-badge-info" />
            <span className="text-sm text-zinc-200">
              {t.backgroundPanel.minimizedLabel.replace('{count}', String(backgroundSessions.length))}
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full shrink-0 chat-col-pad pb-2" data-testid="background-session-panel">
      <div className="mx-auto flex w-full max-w-3xl justify-end">
        <div
          className="w-80 bg-zinc-900 backdrop-blur-sm border border-zinc-700 rounded-xl shadow-md dark:shadow-2xl"
          style={{ zIndex: Z_LAYERS.floatingPanel }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-200">{t.backgroundPanel.title}</h3>
            <button
              onClick={() => setIsMinimized(true)}
              aria-label={t.backgroundPanel.collapseAria}
              className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-600 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-2 space-y-2 max-h-80 overflow-y-auto">
            {backgroundSessions.map((session) => {
              const { isRunning, line } = resolveBackgroundTaskStatusLine(session, lineLabels);
              return (
                <BackgroundSessionItem
                  key={session.sessionId}
                  session={session}
                  onForeground={() => moveToForeground(session.sessionId)}
                  line={isRunning ? formatBackgroundDuration(session.startedAt, now, durationLabels) : line}
                  foregroundAria={t.backgroundPanel.foregroundAria.replace('{title}', session.title)}
                />
              );
            })}
          </div>

          <div className="px-4 py-2 border-t border-zinc-700">
            <p className="text-xs text-zinc-500">{t.backgroundPanel.foregroundHint}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BackgroundSessionPanel;
