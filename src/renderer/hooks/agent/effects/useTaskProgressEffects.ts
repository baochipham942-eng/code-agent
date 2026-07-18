// useAgentTaskProgressEffects - task_progress, task_complete, todo_update
import { useEffect } from 'react';
import type { AgentEventEnvelope, SessionTask, TodoItem } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';

const logger = createLogger('useAgent');

type AgentEvent = AgentEventEnvelope | { type: 'stream_end'; data: null; sessionId?: string };

export interface TaskProgressEventDeps {
  debug: (message: string, context: Record<string, unknown>) => void;
  getCurrentSessionId: () => string | null;
  markSessionUnread: (sessionId: string) => void;
  now: () => number;
  setLastEventAt: (timestamp: number) => void;
  setSessionTaskComplete: AgentEffectsProps['setSessionTaskComplete'];
  setSessionTaskProgress: AgentEffectsProps['setSessionTaskProgress'];
  setSessionTasks: AgentEffectsProps['setSessionTasks'];
  setTodos: AgentEffectsProps['setTodos'];
}

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

function getSessionTasks(data: unknown): SessionTask[] | null {
  if (!isRecord(data)) {
    return null;
  }
  const tasks = data.tasks;
  return Array.isArray(tasks) ? tasks as SessionTask[] : null;
}

export function applyTaskProgressEvent(
  event: AgentEvent,
  deps: TaskProgressEventDeps,
): void {
  const currentSessionId = deps.getCurrentSessionId();
  const eventSessionId = getAgentEventSessionId(event);
  const isCurrentSessionEvent = isAgentEventForCurrentSession(event, currentSessionId);
  const logHandledEvent = () => {
    deps.debug('Received event', { type: event.type, sessionId: event.sessionId });
  };

  switch (event.type) {
    case 'agent_complete':
    case 'agent_cancelled':
    case 'error':
    case 'stream_end':
      return;

    case 'todo_update':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (event.data && isCurrentSessionEvent) {
        const todos = getTodoItems(event.data);
        if (todos) deps.setTodos(todos);
      }
      break;

    case 'task_update':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (event.data && isCurrentSessionEvent) {
        const tasks = getSessionTasks(event.data);
        if (tasks) deps.setSessionTasks(tasks);
      }
      break;

    case 'task_progress':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (event.data && eventSessionId) {
        deps.debug('task_progress', { data: event.data });
        deps.setSessionTaskProgress(eventSessionId, event.data);
        deps.setSessionTaskComplete(eventSessionId, null);
      }
      break;

    case 'task_complete':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (event.data && eventSessionId) {
        deps.debug('task_complete', { data: event.data });
        deps.setSessionTaskComplete(eventSessionId, event.data);
        deps.setSessionTaskProgress(eventSessionId, null);

        if (!isCurrentSessionEvent) {
          deps.debug('Task completed in different session, marking as unread', { eventSessionId });
          deps.markSessionUnread(eventSessionId);
        }
      }
      break;
  }
}

export const useTaskProgressEffects = ({
  lastEventAtRef,
  setSessionTaskComplete,
  setSessionTaskProgress,
  setSessionTasks,
  setTodos,
  updateMessage,
  setIsProcessing,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
}: AgentEffectsProps) => {
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      applyTaskProgressEvent(event, {
        debug: (message, context) => logger.debug(message, context),
        getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
        markSessionUnread: (sessionId) => useSessionStore.getState().markSessionUnread(sessionId),
        now: Date.now,
        setLastEventAt: (timestamp) => {
          lastEventAtRef.current = timestamp;
        },
        setSessionTaskComplete,
        setSessionTaskProgress,
        setSessionTasks,
        setTodos,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [
    updateMessage,
    setSessionTasks,
    setTodos,
    setIsProcessing,
    setPendingPermissionRequest,
    enqueuePermissionRequest,
    setSessionTaskProgress,
    setSessionTaskComplete,
  ]);
};
