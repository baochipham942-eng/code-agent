import type { PermissionDecision, PermissionRequest } from '@shared/contract';

interface PermissionDecisionState {
  pendingPermissionRequest: PermissionRequest | null;
  pendingPermissionSessionId: string | null;
  queuedPermissionRequests: Record<string, PermissionRequest[]>;
  resolvedPermissionRequests: Record<string, PermissionRequest[]>;
}

export function buildPermissionDecisionState(
  state: PermissionDecisionState,
  request: PermissionRequest,
  decision: PermissionDecision,
  sessionId: string | null,
  globalSessionId: string,
): PermissionDecisionState {
  const resolvedRequest: PermissionRequest = { ...request, resolved: true, decision };
  const historyKey = sessionId || request.sessionId || globalSessionId;
  const previousHistory = state.resolvedPermissionRequests[historyKey] || [];
  const queuedPermissionRequests: Record<string, PermissionRequest[]> = {};
  for (const [key, queue] of Object.entries(state.queuedPermissionRequests)) {
    const remaining = queue.filter((item) => item.id !== request.id);
    if (remaining.length > 0) queuedPermissionRequests[key] = remaining;
  }
  const clearsPending = state.pendingPermissionRequest?.id === request.id;

  return {
    resolvedPermissionRequests: {
      ...state.resolvedPermissionRequests,
      [historyKey]: [
        ...previousHistory.filter((item) => item.id !== request.id),
        resolvedRequest,
      ],
    },
    queuedPermissionRequests,
    pendingPermissionRequest: clearsPending ? null : state.pendingPermissionRequest,
    pendingPermissionSessionId: clearsPending ? null : state.pendingPermissionSessionId,
  };
}
