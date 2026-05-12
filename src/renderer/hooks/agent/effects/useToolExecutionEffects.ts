// useAgentToolExecutionEffects - stream_tool_call_start, stream_tool_call_delta, tool_call_start, tool_call_end, tool_call_local, tool_progress, tool_timeout
import { useEffect } from 'react';
import type { ToolCall, ToolOutputDeltaData, ToolProgressData, ToolResult, ToolTimeoutData } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { applyToolOutputDelta } from '../../../utils/toolOutputStreaming';

const logger = createLogger('useAgent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): 同其他 effects hook 文件，应抽 shared AgentEvent 联合按 type narrow
type AgentEvent = { type: string; data: any; sessionId?: string };

export const useToolExecutionEffects = ({
  currentTurnMessageIdRef,
  lastEventAtRef,
  setActiveToolProgress,
  setToolTimeoutWarning,
  updateMessage,
  setTodos,
  setIsProcessing,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
  setSessionTaskProgress,
  setSessionTaskComplete,
  queueUpdate,
}: AgentEffectsProps) => {
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const eventSessionId = event.sessionId || currentSessionId || null;
      const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;
      const getFreshMessages = () => useSessionStore.getState().messages;
      const logHandledEvent = () => {
        const silentEvents = ['stream_tool_call_delta'];
        if (!silentEvents.includes(event.type)) {
          logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
        }
      };

      switch (event.type) {
        case 'agent_complete':
        case 'agent_cancelled':
        case 'error':
        case 'stream_end':
          return;

        case 'stream_tool_call_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data) {
            const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
            const targetMessage = targetMessageId
              ? getFreshMessages().find(m => m.id === targetMessageId)
              : getFreshMessages()[getFreshMessages().length - 1];

            logger.debug('stream_tool_call_start', { data: event.data, targetMessageId });
            if (targetMessage?.role === 'assistant') {
              const newToolCall: ToolCall = {
                id: event.data.id || `pending_${event.data.index}`,
                name: event.data.name || '',
                arguments: {},
                _streaming: true,
                _argumentsRaw: '',
              };
              updateMessage(targetMessage.id, {
                toolCalls: [...(targetMessage.toolCalls || []), newToolCall],
              });
            }
          }
          break;

        case 'stream_tool_call_delta':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data) {
            const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
            const targetMessage = targetMessageId
              ? getFreshMessages().find(m => m.id === targetMessageId)
              : getFreshMessages()[getFreshMessages().length - 1];

            if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
              queueUpdate({
                type: 'tool_call_delta',
                messageId: targetMessage.id,
                index: event.data.index ?? 0,
                name: event.data.name,
                argumentsDelta: event.data.argumentsDelta,
              });
            }
          }
          break;

        case 'tool_call_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data) {
            const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
            const targetMessage = targetMessageId
              ? getFreshMessages().find(m => m.id === targetMessageId)
              : getFreshMessages()[getFreshMessages().length - 1];

            const toolIndex = event.data._index;
            logger.debug('tool_call_start', {
              index: toolIndex,
              id: event.data.id,
              name: event.data.name,
              targetMessageId,
            });

            if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
              if (toolIndex !== undefined && toolIndex < targetMessage.toolCalls.length) {
                const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, idx: number) => {
                  if (idx === toolIndex) {
                    logger.debug('Updating tool call at index', {
                      idx,
                      oldId: tc.id,
                      newId: event.data.id,
                    });
                    return {
                      ...tc,
                      id: event.data.id,
                      name: event.data.name || tc.name,
                      arguments: tc.arguments && Object.keys(tc.arguments).length > 0
                        ? tc.arguments
                        : event.data.arguments,
                      _streaming: false,
                    };
                  }
                  return tc;
                });
                updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
              } else {
                const streamingIndex = targetMessage.toolCalls.findIndex(
                  (tc: ToolCall) => tc._streaming && tc.name === event.data.name
                );
                if (streamingIndex >= 0) {
                  const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, idx: number) => {
                    if (idx === streamingIndex) {
                      return { ...tc, id: event.data.id, _streaming: false };
                    }
                    return tc;
                  });
                  updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
                }
              }
            } else if (targetMessage?.role === 'assistant') {
              updateMessage(targetMessage.id, {
                toolCalls: [event.data],
              });
            }
          }
          break;

        case 'tool_call_end':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data) {
            const toolResult = event.data as ToolResult;

            if (import.meta.env.DEV) {
              logger.debug('tool_call_end received', {
                toolCallId: toolResult.toolCallId,
                success: toolResult.success,
                duration: toolResult.duration,
              });
            }

            let matched = false;
            for (const msg of getFreshMessages()) {
              if (msg.role === 'assistant' && msg.toolCalls) {
                const hasMatch = msg.toolCalls.some((tc: ToolCall) => tc.id === toolResult.toolCallId);
                if (hasMatch) {
                  matched = true;
                  const updatedToolCalls = msg.toolCalls.map((tc: ToolCall) =>
                    tc.id === toolResult.toolCallId
                      ? { ...tc, result: toolResult }
                      : tc
                  );
                  updateMessage(msg.id, { toolCalls: updatedToolCalls });
                  break;
                }
              }
            }

            if (import.meta.env.DEV && !matched) {
              logger.warn('No matching toolCall found', { toolCallId: toolResult.toolCallId });
              logger.debug('Available toolCalls', {
                ids: getFreshMessages()
                  .filter(m => m.toolCalls)
                  .flatMap(m => m.toolCalls!.map(tc => tc.id))
              });
            }

            setActiveToolProgress((prev) => prev?.toolCallId === toolResult.toolCallId ? null : prev);
            setToolTimeoutWarning((prev) => prev?.toolCallId === toolResult.toolCallId ? null : prev);
          }
          break;

        case 'tool_progress':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (event.data) {
            if (!isCurrentSessionEvent) {
              break;
            }
            setActiveToolProgress(event.data as ToolProgressData);
          }
          break;

        case 'tool_output_delta':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent || !event.data?.toolCallId || !event.data?.content) {
            break;
          }
          {
            const delta = event.data as ToolOutputDeltaData;
            for (const msg of getFreshMessages()) {
              if (msg.role !== 'assistant' || !msg.toolCalls) continue;
              const hasMatch = msg.toolCalls.some((tc: ToolCall) => tc.id === delta.toolCallId);
              if (!hasMatch) continue;
              updateMessage(msg.id, {
                toolCalls: applyToolOutputDelta(msg.toolCalls, delta),
              });
              break;
            }
          }
          break;

        case 'tool_timeout':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (event.data) {
            if (!isCurrentSessionEvent) {
              break;
            }
            logger.debug('tool_timeout', { data: event.data });
            setToolTimeoutWarning(event.data as ToolTimeoutData);
          }
          break;

        case 'tool_call_local':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          window.dispatchEvent(new CustomEvent('bridge-tool-call', { detail: event.data }));
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
    queueUpdate,
  ]);
};
