import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import type { SessionRuntimeSummary } from '@shared/ipc';
import type { BackgroundTaskInfo } from '@shared/contract/sessionState';
import type { SessionWithMeta } from '../stores/sessionStore';
import type { SessionState as TaskSessionState } from '../stores/taskStore';

export type SessionStatusKind = 'background' | 'live' | 'paused' | 'error' | 'done';

export interface SessionStatusPresentation {
  kind: SessionStatusKind;
  label: string;
  toneClassName: string;
}

export function getSessionStatusPresentation(args: {
  backgroundTask?: BackgroundTaskInfo;
  runtime?: SessionRuntimeSummary;
  taskState?: TaskSessionState | null;
}): SessionStatusPresentation {
  const { backgroundTask, runtime, taskState } = args;

  if (backgroundTask?.status === 'failed' || taskState?.status === 'error') {
    return {
      kind: 'error',
      label: '出错',
      toneClassName: 'text-red-300 bg-red-500/10 border-red-500/20',
    };
  }

  if (backgroundTask?.status === 'running') {
    return {
      kind: 'background',
      label: '后台',
      toneClassName: 'text-sky-300 bg-sky-500/10 border-sky-500/20',
    };
  }

  if (runtime?.status === 'paused') {
    return {
      kind: 'paused',
      label: '暂停',
      toneClassName: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
    };
  }

  if (taskState?.status === 'running' || taskState?.status === 'queued' || runtime?.status === 'running') {
    return {
      kind: 'live',
      label: '进行中',
      toneClassName: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
    };
  }

  return {
    kind: 'done',
    label: '已完成',
    toneClassName: 'text-zinc-300 bg-zinc-700/40 border-zinc-600/50',
  };
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
