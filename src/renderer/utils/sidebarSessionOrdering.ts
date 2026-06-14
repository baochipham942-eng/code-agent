import type { SessionWithMeta } from '../stores/sessionStore';
import type { SessionStatusKind } from './sessionPresentation';

const RECOVERY_PRIORITY: Record<SessionStatusKind, number> = {
  approval: 0,
  background: 1,
  live: 1,
  error: 2,
  paused: 2,
  incomplete: 2,
  done: 3,
  idle: 3,
};

function defaultActivityAt(session: SessionWithMeta): number {
  return Math.max(session.updatedAt || 0, session.createdAt || 0);
}

export function getSidebarSessionRecoveryPriority(kind: SessionStatusKind): number {
  return RECOVERY_PRIORITY[kind] ?? RECOVERY_PRIORITY.idle;
}

export function sortSidebarSessionsForRecovery(
  sessions: SessionWithMeta[],
  getStatusKind: (session: SessionWithMeta) => SessionStatusKind,
  getActivityAt: (session: SessionWithMeta) => number = defaultActivityAt,
): SessionWithMeta[] {
  return [...sessions].sort((a, b) => {
    const priorityDelta =
      getSidebarSessionRecoveryPriority(getStatusKind(a)) -
      getSidebarSessionRecoveryPriority(getStatusKind(b));
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const activityDelta = getActivityAt(b) - getActivityAt(a);
    if (activityDelta !== 0) {
      return activityDelta;
    }

    const createdDelta = (b.createdAt || 0) - (a.createdAt || 0);
    if (createdDelta !== 0) {
      return createdDelta;
    }

    return a.id.localeCompare(b.id);
  });
}
