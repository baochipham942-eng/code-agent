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
  clearPermissionRequestsForSession: (sessionId: string) => void;
  debug: (message: string, context: Record<string, unknown>) => void;
  enqueuePermissionRequest: AgentEffectsProps['enqueuePermissionRequest'];
  getCurrentSessionId: () => string | null;
  getPendingPermissionRequest: () => PermissionRequest | null;
  markSessionUnread: (sessionId: string) => void;
  now: () => number;
  setLastEventAt: (timestamp: number) => void;
  setPendingPermissionRequest: AgentEffectsProps['setPendingPermissionRequest'];
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
      if (event.sessionId) {
        deps.clearPermissionRequestsForSession(event.sessionId);
      }
      return;

    case 'permission_request': {
      deps.setLastEventAt(deps.now());
      deps.debug('Received event', { type: event.type, sessionId: event.sessionId });
      deps.debug('Permission request received', { data: event.data });
      const permissionRequest = normalizePermissionRequest(event.data);
      if (!permissionRequest) {
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
        clearPermissionRequestsForSession: (sessionId) =>
          useAppStore.getState().clearPermissionRequestsForSession(sessionId),
        debug: (message, context) => logger.debug(message, context),
        enqueuePermissionRequest,
        getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
        getPendingPermissionRequest: () => useAppStore.getState().pendingPermissionRequest,
        markSessionUnread: (sessionId) => useSessionStore.getState().markSessionUnread(sessionId),
        now: Date.now,
        setLastEventAt: (timestamp) => {
          lastEventAtRef.current = timestamp;
        },
        setPendingPermissionRequest,
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
