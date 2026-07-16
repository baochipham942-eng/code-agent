import type { PermissionRequest } from '@shared/contract';
import type { Task } from '@shared/contract/backgroundTask';

export interface SessionPermissionNeedsInputState {
  pendingPermissionRequest?: PermissionRequest | null;
  pendingPermissionSessionId?: string | null;
  queuedPermissionRequests?: Record<string, PermissionRequest[] | undefined> | null;
}

export interface SessionNeedsInputSources {
  permissionState?: SessionPermissionNeedsInputState;
  backgroundTasks?: readonly Task[];
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

export function hasNeedsInputForSession(
  sessionId: string,
  sources: SessionNeedsInputSources = {},
): boolean {
  return (
    hasPendingPermissionForSession(sessionId, sources.permissionState) ||
    hasQueuedPermissionForSession(sessionId, sources.permissionState) ||
    hasWaitingInputBackgroundTaskForSession(sessionId, sources.backgroundTasks)
  );
}

