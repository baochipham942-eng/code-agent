// useAgentPermissionQueueEffects - permission_request, currentSessionId permission drift
import { useEffect } from 'react';
import type { PermissionRequest } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');
const GLOBAL_PERMISSION_REQUEST_SESSION_ID = 'global';

type AgentEvent = { type: string; data?: unknown; sessionId?: string };

export interface PermissionQueueStateDeps {
  currentSessionId: string | null;
  pendingPermissionRequest: PermissionRequest | null;
  pendingPermissionSessionId: string | null;
  enqueuePermissionRequest: AgentEffectsProps['enqueuePermissionRequest'];
  setPendingPermissionRequest: AgentEffectsProps['setPendingPermissionRequest'];
  shiftQueuedPermissionRequest: AgentEffectsProps['shiftQueuedPermissionRequest'];
}

export interface PermissionQueueEventDeps {
  clearForegroundPermissionRequestsForSession: (sessionId: string) => void;
  removePermissionRequestsForBackgroundRun: (identity: { runId?: string | null; agentId?: string | null }) => void;
  debug: (message: string, context: Record<string, unknown>) => void;
  enqueuePermissionRequest: AgentEffectsProps['enqueuePermissionRequest'];
  getCurrentSessionId: () => string | null;
  hasPermissionRequest: (requestId: string) => boolean;
  getPendingPermissionRequest: () => PermissionRequest | null;
  markSessionUnread: (sessionId: string) => void;
  now: () => number;
  setLastEventAt: (timestamp: number) => void;
  setPendingPermissionRequest: AgentEffectsProps['setPendingPermissionRequest'];
  recordPermissionDecision: ReturnType<typeof useAppStore.getState>['recordPermissionDecision'];
  dismissPermissionRequest: ReturnType<typeof useAppStore.getState>['dismissPermissionRequest'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePermissionRequest(data: unknown): PermissionRequest | null {
  if (!isRecord(data) || typeof data.id !== 'string') {
    return null;
  }
  return data as unknown as PermissionRequest;
}

export function reconcilePermissionQueue({
  currentSessionId,
  pendingPermissionRequest,
  pendingPermissionSessionId,
  enqueuePermissionRequest,
  setPendingPermissionRequest,
  shiftQueuedPermissionRequest,
}: PermissionQueueStateDeps): void {
  if (
    pendingPermissionRequest &&
    pendingPermissionSessionId &&
    pendingPermissionSessionId !== GLOBAL_PERMISSION_REQUEST_SESSION_ID &&
    currentSessionId &&
    pendingPermissionSessionId !== currentSessionId
  ) {
    enqueuePermissionRequest(pendingPermissionSessionId, pendingPermissionRequest, { front: true });
    setPendingPermissionRequest(null);
    return;
  }

  if (!pendingPermissionRequest) {
    const nextCurrentRequest = currentSessionId
      ? shiftQueuedPermissionRequest(currentSessionId)
      : null;
    const nextRequest = nextCurrentRequest
      || shiftQueuedPermissionRequest(GLOBAL_PERMISSION_REQUEST_SESSION_ID);

    if (nextRequest) {
      setPendingPermissionRequest(nextRequest, nextCurrentRequest ? currentSessionId : null);
    }
  }
}

export function applyPermissionQueueEvent(
  event: AgentEvent,
  deps: PermissionQueueEventDeps,
): void {
  switch (event.type) {
    case 'agent_complete':
    case 'agent_cancelled':
    case 'error':
    case 'stream_end':
      // 前台 run 终态只清前台（无 run 身份）的请求；后台任务/子代理的审批卡带自己的
      // runId/agentId，宿主侧在前台 run 结束后仍 pending，卡要留给用户点
      // （N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）。它们的收线走下面的 subagent_run_end。
      if (event.sessionId) {
        deps.clearForegroundPermissionRequestsForSession(event.sessionId);
      }
      return;

    case 'subagent_run_end': {
      // 后台 lane 自己收线：它名下未裁决的审批卡已成死卡（宿主不再有这条 run），
      // 按 lane 身份收走，别的 lane 不受牵连。
      const runEndData = isRecord(event.data) ? event.data : null;
      const runId = typeof runEndData?.runId === 'string' && runEndData.runId ? runEndData.runId : null;
      const agentId = typeof runEndData?.agentId === 'string' && runEndData.agentId ? runEndData.agentId : null;
      if (!runId && !agentId) {
        break;
      }
      deps.removePermissionRequestsForBackgroundRun({ runId, agentId });
      return;
    }

    case 'permission_request': {
      deps.setLastEventAt(deps.now());
      deps.debug('Received event', { type: event.type, sessionId: event.sessionId });
      deps.debug('Permission request received', { data: event.data });
      const permissionRequest = normalizePermissionRequest(event.data);
      if (!permissionRequest) {
        break;
      }
      // 手机（companion）先答的终态回传：桌面只收卡——pending 和队列里这条都撤掉，
      // 但不进 recordPermissionDecision，那会把别处做的决定记成本机点击的存证。
      if (permissionRequest.resolved && permissionRequest.resolvedBy === 'companion') {
        deps.dismissPermissionRequest(permissionRequest.id);
        break;
      }
      if (permissionRequest.resolved && permissionRequest.decision) {
        deps.recordPermissionDecision(
          permissionRequest,
          permissionRequest.decision,
          event.sessionId || permissionRequest.sessionId || null,
        );
        break;
      }
      if (deps.hasPermissionRequest(permissionRequest.id)) {
        deps.debug('Duplicate permission request ignored', { requestId: permissionRequest.id });
        break;
      }

      const currentSessionId = deps.getCurrentSessionId();
      const eventSessionId = event.sessionId || currentSessionId || null;
      const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;
      const rawPermissionSessionId = event.sessionId;
      const isGlobalPermissionRequest =
        !rawPermissionSessionId ||
        rawPermissionSessionId === GLOBAL_PERMISSION_REQUEST_SESSION_ID;

      if (isGlobalPermissionRequest) {
        if (!deps.getPendingPermissionRequest()) {
          deps.setPendingPermissionRequest(permissionRequest, null);
        } else {
          deps.enqueuePermissionRequest(
            GLOBAL_PERMISSION_REQUEST_SESSION_ID,
            permissionRequest
          );
        }
        break;
      }

      if (isCurrentSessionEvent && !deps.getPendingPermissionRequest()) {
        deps.setPendingPermissionRequest(permissionRequest, rawPermissionSessionId);
      } else {
        deps.enqueuePermissionRequest(rawPermissionSessionId, permissionRequest);
        deps.markSessionUnread(rawPermissionSessionId);
      }
      break;
    }
  }
}

export const usePermissionQueueEffects = ({
  currentSessionId,
  enqueuePermissionRequest,
  lastEventAtRef,
  pendingPermissionRequest,
  pendingPermissionSessionId,
  setPendingPermissionRequest,
  shiftQueuedPermissionRequest,
  updateMessage,
  setTodos,
  setIsProcessing,
  setSessionTaskProgress,
  setSessionTaskComplete,
}: AgentEffectsProps) => {
  useEffect(() => {
    reconcilePermissionQueue({
      currentSessionId,
      pendingPermissionRequest,
      pendingPermissionSessionId,
      enqueuePermissionRequest,
      setPendingPermissionRequest,
      shiftQueuedPermissionRequest,
    });
  }, [
    currentSessionId,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    enqueuePermissionRequest,
    shiftQueuedPermissionRequest,
    setPendingPermissionRequest,
  ]);

  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      applyPermissionQueueEvent(event, {
        clearForegroundPermissionRequestsForSession: (sessionId) =>
          useAppStore.getState().clearForegroundPermissionRequestsForSession(sessionId),
        removePermissionRequestsForBackgroundRun: (identity) =>
          useAppStore.getState().removePermissionRequestsForBackgroundRun(identity),
        debug: (message, context) => logger.debug(message, context),
        enqueuePermissionRequest,
        getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
        hasPermissionRequest: (requestId) => {
          const state = useAppStore.getState();
          if (state.pendingPermissionRequest?.id === requestId) return true;
          return Object.values(state.queuedPermissionRequests)
            .some((queue) => queue.some((request) => request.id === requestId));
        },
        getPendingPermissionRequest: () => useAppStore.getState().pendingPermissionRequest,
        markSessionUnread: (sessionId) => useSessionStore.getState().markSessionUnread(sessionId),
        now: Date.now,
        setLastEventAt: (timestamp) => {
          lastEventAtRef.current = timestamp;
        },
        setPendingPermissionRequest,
        recordPermissionDecision: useAppStore.getState().recordPermissionDecision,
        dismissPermissionRequest: useAppStore.getState().dismissPermissionRequest,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [
    updateMessage,
    setTodos,
    setIsProcessing,
    setPendingPermissionRequest,
    enqueuePermissionRequest,
    setSessionTaskProgress,
    setSessionTaskComplete,
  ]);
};
