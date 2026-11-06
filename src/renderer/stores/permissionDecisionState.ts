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

/**
 * 另一个面（手机 companion）先答了：桌面只收卡，不进已决存证。
 * resolvedPermissionRequests 是「本机点过」的存证（工具步骤旁的 你已允许/你已拒绝），
 * 把别处的裁决记进去等于替用户在本机上没点过的决定背书。
 */
export function buildPermissionDismissState(
  state: PermissionDecisionState,
  requestId: string,
): Pick<PermissionDecisionState, 'queuedPermissionRequests' | 'pendingPermissionRequest' | 'pendingPermissionSessionId'> {
  const queuedPermissionRequests: Record<string, PermissionRequest[]> = {};
  for (const [key, queue] of Object.entries(state.queuedPermissionRequests)) {
    const remaining = queue.filter((item) => item.id !== requestId);
    if (remaining.length > 0) queuedPermissionRequests[key] = remaining;
  }
  const clearsPending = state.pendingPermissionRequest?.id === requestId;

  return {
    queuedPermissionRequests,
    pendingPermissionRequest: clearsPending ? null : state.pendingPermissionRequest,
    pendingPermissionSessionId: clearsPending ? null : state.pendingPermissionSessionId,
  };
}

/**
 * 后台任务/子代理的审批请求带着自己的 run 身份（subagentToolRuntime 把
 * { agentId, runId } 摊进请求；前台请求两者皆无）。前台 run 结束的清理据此区分：
 * 有身份的是后台任务的卡，留到它被裁决、被取消或它自己的 run 结束；
 * 没身份的按原样清掉（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）。
 */
function belongsToBackgroundTask(request: PermissionRequest): boolean {
  return (typeof request.runId === 'string' && request.runId.length > 0)
    || (typeof request.agentId === 'string' && request.agentId.length > 0);
}

/**
 * run 终态（agent_complete / agent_cancelled / error / stream_end）的会话内清理：
 * 只收该会话里没有 run 身份（前台）的请求；后台任务的 pending 与队列卡原样保留。
 * global 伪会话的挂起特例与 clear 语义一致，只是同样让有身份的请求存活。
 */
export function buildForegroundRunEndState(
  state: PermissionDecisionState,
  sessionId: string,
  globalSessionId: string,
): Pick<PermissionDecisionState, 'queuedPermissionRequests' | 'pendingPermissionRequest' | 'pendingPermissionSessionId'> {
  const queuedPermissionRequests: Record<string, PermissionRequest[]> = {};
  for (const [key, queue] of Object.entries(state.queuedPermissionRequests)) {
    if (key !== sessionId) {
      queuedPermissionRequests[key] = queue;
      continue;
    }
    const remaining = queue.filter((item) => belongsToBackgroundTask(item));
    if (remaining.length > 0) queuedPermissionRequests[key] = remaining;
  }

  const considersPending = state.pendingPermissionSessionId === sessionId
    || (
      sessionId === globalSessionId
      && state.pendingPermissionRequest !== null
      && state.pendingPermissionSessionId === null
    );
  const clearsPending = considersPending
    && state.pendingPermissionRequest !== null
    && !belongsToBackgroundTask(state.pendingPermissionRequest);

  return {
    queuedPermissionRequests,
    pendingPermissionRequest: clearsPending ? null : state.pendingPermissionRequest,
    pendingPermissionSessionId: clearsPending ? null : state.pendingPermissionSessionId,
  };
}

/**
 * 后台任务自己的 run 收线（subagent_run_end，status completed/cancelled/failed）：
 * 它名下还没被裁决的审批卡已成死卡——宿主侧这条 run 已不在，留着只会让人点进
 * unknown_request。按 runId（lane 身份）收掉该 lane 的 pending 与队列卡，别的 lane
 * 不受牵连；收卡不进已决存证（没人在这台机上点过）。
 */
export function buildBackgroundRunEndState(
  state: PermissionDecisionState,
  identity: { runId?: string | null; agentId?: string | null },
): Pick<PermissionDecisionState, 'queuedPermissionRequests' | 'pendingPermissionRequest' | 'pendingPermissionSessionId'> {
  const runId = typeof identity.runId === 'string' && identity.runId ? identity.runId : null;
  const agentId = typeof identity.agentId === 'string' && identity.agentId ? identity.agentId : null;
  const matchesLane = (request: PermissionRequest): boolean =>
    (runId !== null && request.runId === runId)
    || (agentId !== null && request.agentId === agentId);

  const queuedPermissionRequests: Record<string, PermissionRequest[]> = {};
  for (const [key, queue] of Object.entries(state.queuedPermissionRequests)) {
    const remaining = queue.filter((item) => !matchesLane(item));
    if (remaining.length > 0) queuedPermissionRequests[key] = remaining;
  }
  const clearsPending = state.pendingPermissionRequest !== null
    && matchesLane(state.pendingPermissionRequest);

  return {
    queuedPermissionRequests,
    pendingPermissionRequest: clearsPending ? null : state.pendingPermissionRequest,
    pendingPermissionSessionId: clearsPending ? null : state.pendingPermissionSessionId,
  };
}
