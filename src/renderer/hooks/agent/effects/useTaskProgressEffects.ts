// useAgentTaskProgressEffects - task_progress, task_complete, todo_update
import { useEffect } from 'react';
import type { AgentEventEnvelope, TodoItem } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';

const logger = createLogger('useAgent');

type AgentEvent = AgentEventEnvelope | { type: 'stream_end'; data: null; sessionId?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getTodoItems(data: unknown): TodoItem[] | null {
  if (Array.isArray(data)) {
    return data as TodoItem[];
  }
  if (!isRecord(data)) {
    return null;
  }
  const items = data.items;
  return Array.isArray(items) ? items as TodoItem[] : null;
}

export const useTaskProgressEffects = ({
  lastEventAtRef,
  setSessionTaskComplete,
  setSessionTaskProgress,
  setTodos,
  updateMessage,
  setIsProcessing,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
}: AgentEffectsProps) => {
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const eventSessionId = getAgentEventSessionId(event);
      const isCurrentSessionEvent = isAgentEventForCurrentSession(event, currentSessionId);
      const logHandledEvent = () => {
        logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
      };

      switch (event.type) {
        case 'agent_complete':
        case 'agent_cancelled':
        case 'error':
        case 'stream_end':
          return;

        case 'todo_update':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (event.data && isCurrentSessionEvent) {
            const todos = getTodoItems(event.data);
            if (todos) setTodos(todos);
          }
          break;

        case 'task_progress':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (event.data && eventSessionId) {
            logger.debug('task_progress', { data: event.data });
            setSessionTaskProgress(eventSessionId, event.data);
            setSessionTaskComplete(eventSessionId, null);
          }
          break;

        case 'task_complete':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (event.data && eventSessionId) {
            logger.debug('task_complete', { data: event.data });
            setSessionTaskComplete(eventSessionId, event.data);
            setSessionTaskProgress(eventSessionId, null);

            if (!isCurrentSessionEvent) {
              logger.debug('Task completed in different session, marking as unread', { eventSessionId });
              useSessionStore.getState().markSessionUnread(eventSessionId);
            }
          }
          break;
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
