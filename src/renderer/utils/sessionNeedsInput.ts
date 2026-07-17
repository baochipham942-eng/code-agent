import type { PermissionRequest } from '@shared/contract';
import type { UserQuestionRequest } from '@shared/contract';
import type { Task } from '@shared/contract/backgroundTask';

export interface SessionPermissionNeedsInputState {
  pendingPermissionRequest?: PermissionRequest | null;
  pendingPermissionSessionId?: string | null;
  queuedPermissionRequests?: Record<string, PermissionRequest[] | undefined> | null;
}

export interface SessionNeedsInputSources {
  permissionState?: SessionPermissionNeedsInputState;
  backgroundTasks?: readonly Task[];
  pendingUserQuestionsBySessionId?: Map<string, readonly UserQuestionRequest[]> | null;
  durableWaitingInputSessionIds?: ReadonlySet<string> | null;
}

export function hasPendingPermissionForSession(
  sessionId: string,
  state: SessionPermissionNeedsInputState = {},
): boolean {
  return Boolean(
    state.pendingPermissionRequest &&
    state.pendingPermissionSessionId === sessionId
  );
}

export function hasQueuedPermissionForSession(
  sessionId: string,
  state: SessionPermissionNeedsInputState = {},
): boolean {
  return (state.queuedPermissionRequests?.[sessionId]?.length ?? 0) > 0;
}

export function hasWaitingInputBackgroundTaskForSession(
  sessionId: string,
  tasks: readonly Task[] = [],
): boolean {
  return tasks.some((task) => task.sessionId === sessionId && task.status === 'waiting_input');
}

export function hasPendingUserQuestionForSession(
  sessionId: string,
  pendingUserQuestionsBySessionId?: Map<string, readonly UserQuestionRequest[]> | null,
): boolean {
  return (pendingUserQuestionsBySessionId?.get(sessionId)?.length ?? 0) > 0;
}

export function hasDurableWaitingForSession(
  sessionId: string,
  durableWaitingInputSessionIds?: ReadonlySet<string> | null,
): boolean {
  return durableWaitingInputSessionIds?.has(sessionId) ?? false;
}

export function hasNeedsInputForSession(
  sessionId: string,
  sources: SessionNeedsInputSources = {},
): boolean {
  return (
    hasPendingPermissionForSession(sessionId, sources.permissionState) ||
    hasQueuedPermissionForSession(sessionId, sources.permissionState) ||
    hasWaitingInputBackgroundTaskForSession(sessionId, sources.backgroundTasks) ||
    hasPendingUserQuestionForSession(sessionId, sources.pendingUserQuestionsBySessionId) ||
    hasDurableWaitingForSession(sessionId, sources.durableWaitingInputSessionIds)
  );
}
