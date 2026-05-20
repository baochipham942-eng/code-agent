// useAgentSessionLifecycleEffects - agent_complete, error, stream_end, message completion, research_detected, research_mode_started, interrupt_start, interrupt_acknowledged, interrupt_complete, stale processing cleanup
import { useEffect } from 'react';
import type { AgentEventEnvelope, Message, ResearchDetectedData } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTaskStore, type SessionStatus } from '../../../stores/taskStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');

type AgentEvent = AgentEventEnvelope | { type: 'stream_end'; data: null; sessionId?: string };

type AgentErrorPayload = Record<string, unknown>;

function isRecord(value: unknown): value is AgentErrorPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentErrorPayload(data: unknown): AgentErrorPayload {
  if (!isRecord(data)) return {};
  const nested = isRecord(data.data) ? data.data : {};
  return { ...data, ...nested };
}

function getNumberPayloadField(data: unknown, field: string): number | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === 'number' ? value : undefined;
}

export function getAgentErrorMessage(data: unknown): string | null {
  const payload = normalizeAgentErrorPayload(data);
  const message = typeof payload.message === 'string'
    ? payload.message.trim()
    : typeof payload.error === 'string'
      ? payload.error.trim()
      : '';
  return message || null;
}

export function isTerminalAgentError(data: unknown): boolean {
  const payload = normalizeAgentErrorPayload(data);
  return payload.terminal !== false
    && payload.level !== 'warning'
    && payload.severity !== 'warning';
}

export function formatAgentErrorContent(data: unknown): string | null {
  const payload = normalizeAgentErrorPayload(data);
  const message = getAgentErrorMessage(payload);
  if (!message) return null;

  if (payload.code === 'CONTEXT_LENGTH_EXCEEDED') {
    const details = payload.details;
    const requested = getNumberPayloadField(details, 'requested');
    const max = getNumberPayloadField(details, 'max');
    const requestedK = requested ? Math.round(requested / 1000) : '?';
    const maxK = max ? Math.round(max / 1000) : '?';
    const suggestion = typeof payload.suggestion === 'string'
      ? payload.suggestion
      : '建议新开一个会话继续对话。';
    return (
      `⚠️ **${message}**\n\n` +
      `当前对话长度约 ${requestedK}K tokens，超出模型限制 ${maxK}K tokens。\n\n` +
      `${suggestion}`
    );
  }

  return `Error: ${message}`;
}

function mergeErrorContent(existing: string | undefined, errorContent: string): string {
  const current = existing || '';
  const trimmed = current.trim();
  if (!trimmed || trimmed.startsWith('Error:') || trimmed.startsWith('⚠️')) {
    return errorContent;
  }
  return `${current}\n\n${errorContent}`;
}

function clearRuntimeSessionState(sessionId: string): void {
  const currentStatus = useTaskStore.getState().sessionStates[sessionId]?.status;
  const shouldClear: SessionStatus[] = ['running', 'paused', 'queued', 'cancelling'];
  if (!currentStatus || shouldClear.includes(currentStatus)) {
    useTaskStore.getState().updateSessionState(sessionId, { status: 'idle' });
  }
}

function markRuntimeSessionCancelled(sessionId: string): void {
  useTaskStore.getState().updateSessionState(sessionId, { status: 'cancelled' });
}

function removeUncommittedAssistantDraft(
  messages: Message[],
  draftMessageId: string | null | undefined,
): Message[] {
  if (!draftMessageId) return messages;
  const draft = messages.find((message) => message.id === draftMessageId);
  if (draft?.role !== 'assistant') return messages;
  if ((draft.toolCalls?.length || 0) > 0) return messages;
  return messages.filter((message) => message.id !== draftMessageId);
}

function markLatestUserTurnCancelled(
  draftMessageId: string | null | undefined,
  cancelledAt: number,
): void {
  const store = useSessionStore.getState();
  const messages = store.messages;
  let latestUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.isMeta) {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) return;

  const markedMessages = messages.map((message, index) => {
    if (index !== latestUserIndex) return message;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        workbench: {
          ...message.metadata?.workbench,
          runCancellation: {
            status: 'cancelled' as const,
            cancelledAt,
            reason: 'user_cancelled',
          },
        },
      },
    };
  });

  store.setMessages(removeUncommittedAssistantDraft(markedMessages, draftMessageId));
}

export const useSessionLifecycleEffects = ({
  currentTurnMessageIdRef,
  flushRef,
  lastEventAtRef,
  setActiveToolProgress,
  setIsInterrupting,
  setIsProcessing,
  setResearchDetected,
  setSessionTaskComplete,
  setSessionTaskProgress,
  setTodos,
  setToolTimeoutWarning,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
  updateMessage,
}: AgentEffectsProps) => {
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const eventSessionId = event.sessionId || currentSessionId || null;
      const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;
      const getFreshMessages = () => useSessionStore.getState().messages;
      const clearSessionProcessing = () => {
        const sessionId = eventSessionId;
        if (sessionId) {
          useAppStore.getState().setSessionProcessing(sessionId, false);
        } else {
          setIsProcessing(false);
        }
      };
      const refreshContextHealth = () => {
        if (!isCurrentSessionEvent || !eventSessionId) return;
        useSessionStore.getState().refreshContextHealth(eventSessionId).catch((error) => {
          logger.warn('Failed to refresh context health after agent event', {
            sessionId: eventSessionId,
            eventType: event.type,
            error,
          });
        });
      };
      const logHandledEvent = () => {
        logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
      };

      switch (event.type) {
        case 'message':
          lastEventAtRef.current = Date.now();
          if (event.data && (!event.data.toolCalls || event.data.toolCalls.length === 0)) {
            clearSessionProcessing();
          }
          break;

        case 'error':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isTerminalAgentError(event.data)) {
            logger.warn('Agent warning', {
              message: getAgentErrorMessage(event.data),
              code: normalizeAgentErrorPayload(event.data).code,
            });
            break;
          }
          logger.error('Agent error', {
            message: getAgentErrorMessage(event.data),
            code: normalizeAgentErrorPayload(event.data).code,
          });
          if (isCurrentSessionEvent) {
            const lastMessage = getFreshMessages()[getFreshMessages().length - 1];
            if (lastMessage?.role === 'assistant') {
              const errorContent = formatAgentErrorContent(event.data);
              if (errorContent) {
                updateMessage(lastMessage.id, {
                  content: mergeErrorContent(lastMessage.content, errorContent),
                });
              }
            }
          }
          clearSessionProcessing();
          refreshContextHealth();
          break;

        case 'agent_complete':
        case 'agent_cancelled':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (isCurrentSessionEvent) {
            flushRef.current();
            setActiveToolProgress(null);
            setToolTimeoutWarning(null);
            if (event.type === 'agent_cancelled') {
              markLatestUserTurnCancelled(currentTurnMessageIdRef.current, Date.now());
              currentTurnMessageIdRef.current = null;
            }
          }
          clearSessionProcessing();
          if (eventSessionId) {
            if (event.type === 'agent_cancelled') {
              markRuntimeSessionCancelled(eventSessionId);
            } else {
              clearRuntimeSessionState(eventSessionId);
            }
          }
          if (eventSessionId) {
            setSessionTaskProgress(eventSessionId, null);
          }
          refreshContextHealth();
          break;

        case 'research_detected':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data) {
            logger.debug('research_detected', { data: event.data });
            setResearchDetected(event.data as ResearchDetectedData);
          }
          break;

        case 'research_mode_started':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          setResearchDetected(null);
          break;

        case 'interrupt_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          logger.debug('interrupt_start', { data: event.data });
          setIsInterrupting(true);
          break;

        case 'interrupt_acknowledged':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          logger.debug('interrupt_acknowledged', { data: event.data });
          break;

        case 'interrupt_complete':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          logger.debug('interrupt_complete', { data: event.data });
          setIsInterrupting(false);
          break;

        case 'stream_end':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            clearSessionProcessing();
            break;
          }
          logger.debug('stream_end - ensuring processing state is cleared');
          flushRef.current();
          clearSessionProcessing();
          refreshContextHealth();
          break;

        default:
          lastEventAtRef.current = Date.now();
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

  useEffect(() => {
    const STALE_MS = 5 * 60 * 1000;
    const CHECK_INTERVAL_MS = 30_000;
    const timer = setInterval(() => {
      const appState = useAppStore.getState();
      const hasProcessing = appState.isProcessing || appState.processingSessionIds.size > 0;
      if (!hasProcessing) return;
      const idleMs = Date.now() - lastEventAtRef.current;
      if (idleMs < STALE_MS) return;
      logger.warn(`[useAgent] No SSE events for ${Math.round(idleMs / 1000)}s while processing — auto-clearing stale state`);
      Array.from(appState.processingSessionIds).forEach((sid) => appState.setSessionProcessing(sid, false));
      appState.setIsProcessing(false);
      lastEventAtRef.current = Date.now();
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
};
