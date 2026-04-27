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

type AgentEvent = { type: string; data: any; sessionId?: string };

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
      const nextGlobalRequest = shiftQueuedPermissionRequest(GLOBAL_PERMISSION_REQUEST_SESSION_ID);
      const nextRequest = nextCurrentRequest || nextGlobalRequest;

      if (nextRequest) {
        setPendingPermissionRequest(nextRequest, nextCurrentRequest ? currentSessionId : null);
      }
    }
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
      switch (event.type) {
        case 'agent_complete':
        case 'agent_cancelled':
        case 'error':
        case 'stream_end':
          return;

        case 'permission_request': {
          lastEventAtRef.current = Date.now();
          logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
          logger.debug('Permission request received', { data: event.data });
          if (!event.data?.id) {
            break;
          }

          const currentSessionId = useSessionStore.getState().currentSessionId;
          const eventSessionId = event.sessionId || currentSessionId || null;
          const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;
          const rawPermissionSessionId = event.sessionId;
          const isGlobalPermissionRequest =
            !rawPermissionSessionId ||
            rawPermissionSessionId === GLOBAL_PERMISSION_REQUEST_SESSION_ID;

          if (isGlobalPermissionRequest) {
            if (!useAppStore.getState().pendingPermissionRequest) {
              setPendingPermissionRequest(event.data as PermissionRequest, null);
            } else {
              enqueuePermissionRequest(
                GLOBAL_PERMISSION_REQUEST_SESSION_ID,
                event.data as PermissionRequest
              );
            }
            break;
          }

          if (isCurrentSessionEvent && !useAppStore.getState().pendingPermissionRequest) {
            setPendingPermissionRequest(event.data as PermissionRequest, rawPermissionSessionId);
          } else {
            enqueuePermissionRequest(rawPermissionSessionId, event.data as PermissionRequest);
            useSessionStore.getState().markSessionUnread(rawPermissionSessionId);
          }
          break;
        }
      }
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
