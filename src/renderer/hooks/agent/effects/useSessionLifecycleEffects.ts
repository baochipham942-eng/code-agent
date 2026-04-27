// useAgentSessionLifecycleEffects - agent_complete, error, stream_end, message completion, research_detected, research_mode_started, interrupt_start, interrupt_acknowledged, interrupt_complete, stale processing cleanup
import { useEffect } from 'react';
import type { ResearchDetectedData } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');

type AgentEvent = { type: string; data: any; sessionId?: string };

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
          logger.error('Agent error', { message: event.data?.message, code: event.data?.code });
          if (isCurrentSessionEvent) {
            const lastMessage = getFreshMessages()[getFreshMessages().length - 1];
            if (lastMessage?.role === 'assistant') {
              let errorContent: string;
              if (event.data?.code === 'CONTEXT_LENGTH_EXCEEDED') {
                const details = event.data.details;
                const requestedK = details?.requested ? Math.round(details.requested / 1000) : '?';
                const maxK = details?.max ? Math.round(details.max / 1000) : '?';
                errorContent =
                  `⚠️ **${event.data.message}**\n\n` +
                  `当前对话长度约 ${requestedK}K tokens，超出模型限制 ${maxK}K tokens。\n\n` +
                  `${event.data.suggestion || '建议新开一个会话继续对话。'}`;
              } else {
                errorContent = `Error: ${event.data?.message || 'Unknown error'}`;
              }
              updateMessage(lastMessage.id, { content: errorContent });
            }
          }
          clearSessionProcessing();
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
