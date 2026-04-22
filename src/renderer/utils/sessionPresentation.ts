import type { SessionStatus } from '@shared/contract/session';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { BackgroundTaskInfo } from '@shared/contract/sessionState';
import type { SessionWithMeta } from '../stores/sessionStore';
import type { SessionState as TaskSessionState } from '../stores/taskStore';

export type SessionStatusKind = 'background' | 'live' | 'paused' | 'error' | 'done' | 'idle';

export interface SessionStatusPresentation {
  kind: SessionStatusKind;
  label: string;
  toneClassName: string;
}

const PRESENTATION: Record<SessionStatusKind, SessionStatusPresentation> = {
  error:      { kind: 'error',      label: '出错',   toneClassName: 'text-red-300 bg-red-500/10 border-red-500/20' },
  background: { kind: 'background', label: '后台',   toneClassName: 'text-sky-300 bg-sky-500/10 border-sky-500/20' },
  paused:     { kind: 'paused',     label: '暂停',   toneClassName: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  live:       { kind: 'live',       label: '进行中', toneClassName: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  done:       { kind: 'done',       label: '已完成', toneClassName: 'text-zinc-300 bg-zinc-700/40 border-zinc-600/50' },
  idle:       { kind: 'idle',       label: '就绪',   toneClassName: 'text-zinc-400 bg-zinc-700/30 border-zinc-600/40' },
};

/**
 * Classify a session's status for sidebar display.
 *
 * Three priority tiers:
 * - P1 live in-memory signals (backgroundTask / runtime / taskState): win first,
 *   these reflect the running process and update in real time.
 * - P2 DB-persisted sessionStatus: survives restart; when the process is gone
 *   but the database remembers 'running'/'completed'/'error', trust it.
 * - P3 messageCount fallback: for sessions with no status but a history,
 *   prefer 'done' over 'idle'; a truly untouched session still renders 'idle'.
 */
export function getSessionStatusPresentation(args: {
  backgroundTask?: BackgroundTaskInfo;
  runtime?: SessionRuntimeSummary;
  taskState?: TaskSessionState | null;
  messageCount?: number;
  sessionStatus?: SessionStatus;
}): SessionStatusPresentation {
  const { backgroundTask, runtime, taskState, messageCount, sessionStatus } = args;

  // P1: Live in-memory signals
  if (backgroundTask?.status === 'failed' || taskState?.status === 'error') {
    return PRESENTATION.error;
  }
  if (backgroundTask?.status === 'running') {
    return PRESENTATION.background;
  }
  if (runtime?.status === 'paused') {
    return PRESENTATION.paused;
  }
  if (
    taskState?.status === 'running' ||
    taskState?.status === 'queued' ||
    runtime?.status === 'running'
  ) {
    return PRESENTATION.live;
  }

  // P2: DB-persisted status survives restart
  if (sessionStatus === 'error') {
    return PRESENTATION.error;
  }
  if (sessionStatus === 'running') {
    // DB says the session was running. Either it genuinely still is (zombie
    // because in-memory runtime is gone) or it crashed mid-turn. Either way,
    // 'live' is more informative than 'done'.
    return PRESENTATION.live;
  }
  if (sessionStatus === 'completed') {
    return PRESENTATION.done;
  }

  // P3: messageCount fallback for sessions without explicit status
  const hasHistory = typeof messageCount === 'number' && messageCount > 0;
  if (hasHistory) {
    return PRESENTATION.done;
  }

  const hasNoInMemoryRuntime = !runtime && !taskState && !backgroundTask;
  if (hasNoInMemoryRuntime) {
    return PRESENTATION.idle;
  }

  return PRESENTATION.done;
}

export function buildSessionSearchText(args: {
  session: SessionWithMeta;
  snapshot?: SessionWorkbenchSnapshot;
  status: SessionStatusPresentation;
}): string {
  const { session, snapshot, status } = args;
  return [
    session.title,
    session.workingDirectory,
    session.gitBranch,
    status.label,
    snapshot?.summary,
    snapshot?.labels.join(' '),
    snapshot?.recentToolNames.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
