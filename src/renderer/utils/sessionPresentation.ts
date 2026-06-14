import type { SessionStatus } from '@shared/contract/session';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { BackgroundTaskInfo } from '@shared/contract/sessionState';
import { stripAppshotBlocks } from '@shared/contract/appshot';
import type { SessionWithMeta } from '../stores/sessionStore';
import type { SessionStatusFilter } from '../stores/sessionUIStore';
import type { SessionState as TaskSessionState } from '../stores/taskStore';

export type SessionStatusKind = 'background' | 'live' | 'approval' | 'paused' | 'error' | 'done' | 'incomplete' | 'idle';

export interface SessionStatusPresentation {
  kind: SessionStatusKind;
  label: string;
  toneClassName: string;
  showBadge: boolean;
}

const PRESENTATION: Record<SessionStatusKind, SessionStatusPresentation> = {
  error:      { kind: 'error',      label: '待处理', toneClassName: 'text-red-300 bg-red-500/10 border-red-500/20', showBadge: true },
  background: { kind: 'background', label: '执行中', toneClassName: 'text-sky-300 bg-sky-500/10 border-sky-500/20', showBadge: true },
  paused:     { kind: 'paused',     label: '待处理', toneClassName: 'text-amber-300 bg-amber-500/10 border-amber-500/20', showBadge: true },
  live:       { kind: 'live',       label: '执行中', toneClassName: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20', showBadge: true },
  approval:   { kind: 'approval',   label: '待确认', toneClassName: 'text-violet-300 bg-violet-500/10 border-violet-500/20', showBadge: true },
  done:       { kind: 'done',       label: '已完成', toneClassName: 'text-zinc-300 bg-zinc-700/40 border-zinc-600/50', showBadge: false },
  incomplete: { kind: 'incomplete', label: '待处理', toneClassName: 'text-amber-300 bg-amber-500/10 border-amber-500/20', showBadge: true },
  idle:       { kind: 'idle',       label: '就绪',   toneClassName: 'text-zinc-400 bg-zinc-700/30 border-zinc-600/40', showBadge: false },
};

const UNFINISHED_STATUS_KINDS: ReadonlySet<SessionStatusKind> = new Set([
  'approval',
  'background',
  'live',
  'paused',
  'error',
  'incomplete',
]);

const ATTENTION_STATUS_KINDS: ReadonlySet<SessionStatusKind> = new Set([
  'paused',
  'error',
  'incomplete',
]);

export function matchesSessionStatusFilter(
  filter: SessionStatusFilter,
  kind: SessionStatusKind,
  options: { hasDeliverySignals?: boolean; hasPendingReview?: boolean } = {},
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'unfinished':
      return UNFINISHED_STATUS_KINDS.has(kind);
    case 'approval':
      return kind === 'approval';
    case 'running':
      return kind === 'background' || kind === 'live';
    case 'attention':
      return ATTENTION_STATUS_KINDS.has(kind);
    case 'artifact':
      return options.hasDeliverySignals === true;
    case 'review':
      return options.hasPendingReview === true;
    case 'background':
      return kind === 'background';
    default:
      return true;
  }
}

export function getDisplaySessionTitle(title?: string | null): string {
  const rawTitle = title?.trim() ?? '';
  const stripped = stripAppshotBlocks(rawTitle);
  if (stripped && !stripped.trim().startsWith('<appshot')) {
    return stripped;
  }
  if (rawTitle.startsWith('<appshot')) {
    return 'Appshot 会话';
  }
  return rawTitle || '未命名会话';
}

/**
 * Classify a session's status for sidebar display.
 *
 * Three priority tiers:
 * - P1 action signals (pending approval / backgroundTask / runtime / taskState):
 *   win first, these reflect whether the user needs to look at the session now.
 * - P2 DB-persisted sessionStatus: survives restart; when the process is gone
 *   but the database remembers 'running'/'completed'/'error', trust it.
 * - P3 messageCount fallback: for sessions with no status but a history,
 *   hide completed/idle badges and only surface prompt-only sessions as
 *   needing attention.
 */
export function getSessionStatusPresentation(args: {
  backgroundTask?: BackgroundTaskInfo;
  runtime?: SessionRuntimeSummary;
  taskState?: TaskSessionState | null;
  messageCount?: number;
  turnCount?: number;
  sessionStatus?: SessionStatus;
  hasPendingApproval?: boolean;
}): SessionStatusPresentation {
  const { backgroundTask, runtime, taskState, messageCount, turnCount, sessionStatus, hasPendingApproval } = args;

  // P1: Actionable live signals
  if (backgroundTask?.status === 'failed' || taskState?.status === 'error') {
    return PRESENTATION.error;
  }
  if (hasPendingApproval) {
    return PRESENTATION.approval;
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
  if (sessionStatus === 'error' || sessionStatus === 'interrupted' || sessionStatus === 'orphaned') {
    return PRESENTATION.error;
  }
  if (sessionStatus === 'running' || sessionStatus === 'queued' || sessionStatus === 'paused' || sessionStatus === 'cancelling') {
    return PRESENTATION.live;
  }
  if (sessionStatus === 'completed') {
    return PRESENTATION.done;
  }

  // P3: messageCount fallback for sessions without explicit status
  const hasHistory = typeof messageCount === 'number' && messageCount > 0;
  if (hasHistory) {
    if (
      typeof turnCount === 'number' &&
      turnCount > 0 &&
      messageCount <= turnCount
    ) {
      return PRESENTATION.incomplete;
    }
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
    getDisplaySessionTitle(session.title),
    session.type,
    session.origin?.name,
    session.workingDirectory,
    session.gitBranch,
    status.showBadge ? status.label : undefined,
    snapshot?.summary,
    snapshot?.labels.join(' '),
    snapshot?.recentToolNames.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
