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
  durableWaitingApprovalSessionIds?: ReadonlySet<string> | null;
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

/** Exact approval correlation: renderer status changes only when the approval names this tool call. */
export function isToolCallAwaitingApproval(
  toolCallId: string,
  sessionId: string | null | undefined,
  state: SessionPermissionNeedsInputState = {},
): boolean {
  const matches = (request: PermissionRequest | null | undefined) => (
    request?.resolved !== true && request?.parentToolUseId === toolCallId
  );
  if (matches(state.pendingPermissionRequest)) {
    return !sessionId
      || !state.pendingPermissionSessionId
      || state.pendingPermissionSessionId === sessionId;
  }
  if (!sessionId) return false;
  return (state.queuedPermissionRequests?.[sessionId] ?? []).some(matches);
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

export function hasDurableWaitingApprovalForSession(
  sessionId: string,
  durableWaitingApprovalSessionIds?: ReadonlySet<string> | null,
): boolean {
  return durableWaitingApprovalSessionIds?.has(sessionId) ?? false;
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
    hasDurableWaitingApprovalForSession(sessionId, sources.durableWaitingApprovalSessionIds)
  );
}
