// useAgentSessionLifecycleEffects - agent_complete, error, stream_end, message completion, research_detected, research_mode_started, interrupt_start, interrupt_acknowledged, interrupt_complete, stale processing cleanup
import { useEffect } from 'react';
import type { ResearchDetectedData } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): 同其他 effects hook 文件，应抽 shared AgentEvent 联合按 type narrow
type AgentEvent = { type: string; data: any; sessionId?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): error payload 历史 schema 不一（{ message }/{ code, message }/{ stack }），应抽 AgentErrorPayload 联合后用 zod 校验
type AgentErrorPayload = Record<string, any>;

function isRecord(value: unknown): value is AgentErrorPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentErrorPayload(data: unknown): AgentErrorPayload {
  if (!isRecord(data)) return {};
  const nested = isRecord(data.data) ? data.data : {};
  return { ...data, ...nested };
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
    const requestedK = details?.requested ? Math.round(details.requested / 1000) : '?';
    const maxK = details?.max ? Math.round(details.max / 1000) : '?';
    return (
      `⚠️ **${message}**\n\n` +
      `当前对话长度约 ${requestedK}K tokens，超出模型限制 ${maxK}K tokens。\n\n` +
      `${payload.suggestion || '建议新开一个会话继续对话。'}`
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

export const useSessionLifecycleEffects = ({
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
          }
          clearSessionProcessing();
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
