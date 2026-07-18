// useAgentToolExecutionEffects - stream_tool_call_start, stream_tool_call_delta, tool_call_start, tool_call_end, tool_call_local, tool_progress, tool_timeout
import { useEffect } from 'react';
import type {
  AgentPointerEvent,
  AgentEventEnvelope,
  Message,
  ToolCall,
  ToolOutputDeltaData,
  ToolProgressData,
  ToolResult,
  ToolTimeoutData,
} from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { applyToolOutputDelta } from '../../../utils/toolOutputStreaming';
import { useCapabilityGapStore } from '../../../stores/capabilityGapStore';
import type { CapabilityGapNotice } from '../../../stores/capabilityGapStore';
import { isAgentPointerEvent, useAgentPointerStore } from '../../../stores/agentPointerStore';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';
import { buildAgentPointerEvent } from '../../../utils/agentPointer';

const logger = createLogger('useAgent');

export type ToolExecutionEvent = AgentEventEnvelope | {
  type: 'stream_end';
  data: null;
  sessionId?: string;
};

export interface ToolExecutionEventDeps {
  clearAgentPointers: () => void;
  debug: (message: string, context: Record<string, unknown>) => void;
  dispatchBridgeToolCall: (data: unknown) => void;
  getCurrentSessionId: () => string | null;
  getCurrentTurnMessageId: () => string | null;
  getMessages: () => Message[];
  isDev: boolean;
  now: () => number;
  queueUpdate: AgentEffectsProps['queueUpdate'];
  recordAgentPointer: (event: AgentPointerEvent) => void;
  setActiveToolProgress: AgentEffectsProps['setActiveToolProgress'];
  setCapabilityGapNotice: (sessionId: string, notice: CapabilityGapNotice) => void;
  setLastEventAt: (timestamp: number) => void;
  setToolTimeoutWarning: AgentEffectsProps['setToolTimeoutWarning'];
  updateMessage: AgentEffectsProps['updateMessage'];
  warn: (message: string, context: Record<string, unknown>) => void;
}

function recordAgentPointerFromToolCall(
  toolCall: Pick<ToolCall, 'id' | 'name' | 'arguments' | 'result'>,
  recordAgentPointer: ToolExecutionEventDeps['recordAgentPointer'],
): void {
  const event = buildAgentPointerEvent(toolCall);
  if (event) {
    recordAgentPointer(event);
  }
}

function recordAgentPointerFromToolResult(
  toolResult: ToolResult,
  matchedToolCall: ToolCall | null,
  recordAgentPointer: ToolExecutionEventDeps['recordAgentPointer'],
): void {
  if (matchedToolCall) {
    recordAgentPointerFromToolCall({
      ...matchedToolCall,
      result: toolResult,
    }, recordAgentPointer);
    return;
  }

  const metadataEvent = toolResult.metadata?.agentPointerEvent;
  if (isAgentPointerEvent(metadataEvent)) {
    recordAgentPointer(metadataEvent);
  }
}

export function applyToolExecutionEvent(
  event: ToolExecutionEvent,
  deps: ToolExecutionEventDeps,
): void {
  const currentSessionId = deps.getCurrentSessionId();
  const eventSessionId = getAgentEventSessionId(event);
  const isCurrentSessionEvent = isAgentEventForCurrentSession(event, currentSessionId);
  const logHandledEvent = () => {
    const silentEvents = ['stream_tool_call_delta'];
    if (!silentEvents.includes(event.type)) {
      deps.debug('Received event', { type: event.type, sessionId: event.sessionId });
    }
  };

  switch (event.type) {
    case 'agent_complete':
    case 'agent_cancelled':
    case 'error':
    case 'stream_end':
      if (!eventSessionId || isCurrentSessionEvent) {
        deps.clearAgentPointers();
      }
      return;

    case 'stream_tool_call_start':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (!isCurrentSessionEvent) {
        break;
      }
      if (event.data) {
        const targetMessageId = event.data.turnId || deps.getCurrentTurnMessageId();
        const targetMessage = targetMessageId
          ? deps.getMessages().find(m => m.id === targetMessageId)
          : deps.getMessages()[deps.getMessages().length - 1];

        deps.debug('stream_tool_call_start', { data: event.data, targetMessageId });
        if (targetMessage?.role === 'assistant') {
          const newToolCall: ToolCall = {
            id: event.data.id || `pending_${event.data.index}`,
            name: event.data.name || '',
            arguments: {},
            _streaming: true,
            _argumentsRaw: '',
          };
          deps.updateMessage(targetMessage.id, {
            toolCalls: [...(targetMessage.toolCalls || []), newToolCall],
          });
        }
      }
      break;

    case 'stream_tool_call_delta':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (!isCurrentSessionEvent) {
        break;
      }
      if (event.data) {
        const targetMessageId = event.data.turnId || deps.getCurrentTurnMessageId();
        const targetMessage = targetMessageId
          ? deps.getMessages().find(m => m.id === targetMessageId)
          : deps.getMessages()[deps.getMessages().length - 1];

        if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
          deps.queueUpdate({
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
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (!isCurrentSessionEvent) {
        break;
      }
      if (event.data) {
        const targetMessageId = event.data.turnId || deps.getCurrentTurnMessageId();
        const targetMessage = targetMessageId
          ? deps.getMessages().find(m => m.id === targetMessageId)
          : deps.getMessages()[deps.getMessages().length - 1];

        const toolIndex = event.data._index;
        deps.debug('tool_call_start', {
          index: toolIndex,
          id: event.data.id,
          name: event.data.name,
          targetMessageId,
        });
        recordAgentPointerFromToolCall(event.data, deps.recordAgentPointer);

        if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
          if (toolIndex !== undefined && toolIndex < targetMessage.toolCalls.length) {
            const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, idx: number) => {
              if (idx === toolIndex) {
                deps.debug('Updating tool call at index', {
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
            deps.updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
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
              deps.updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
            }
          }
        } else if (targetMessage?.role === 'assistant') {
          deps.updateMessage(targetMessage.id, {
            toolCalls: [event.data],
          });
        }
      }
      break;

    case 'tool_call_end':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (!isCurrentSessionEvent) {
        break;
      }
      if (event.data) {
        const toolResult = event.data as ToolResult;

        if (deps.isDev) {
          deps.debug('tool_call_end received', {
            toolCallId: toolResult.toolCallId,
            success: toolResult.success,
            duration: toolResult.duration,
          });
        }

        let matched = false;
        let matchedToolCall: ToolCall | null = null;
        for (const msg of deps.getMessages()) {
          if (msg.role === 'assistant' && msg.toolCalls) {
            const found = msg.toolCalls.find((tc: ToolCall) => tc.id === toolResult.toolCallId);
            if (found) {
              matched = true;
              matchedToolCall = found;
              const updatedToolCalls = msg.toolCalls.map((tc: ToolCall) =>
                tc.id === toolResult.toolCallId
                  ? { ...tc, result: toolResult }
                  : tc
              );
              deps.updateMessage(msg.id, { toolCalls: updatedToolCalls });
              break;
            }
          }
        }

        if (
          matchedToolCall?.name === 'recommend_capability'
          && toolResult.success
          && toolResult.metadata
          && eventSessionId
        ) {
          const meta = toolResult.metadata as {
            requiredCapability?: string;
            gaps?: CapabilityGapNotice['gaps'];
          };
          if (typeof meta.requiredCapability === 'string' && Array.isArray(meta.gaps)) {
            deps.setCapabilityGapNotice(eventSessionId, {
              requiredCapability: meta.requiredCapability,
              gaps: meta.gaps,
              toolCallId: toolResult.toolCallId,
            });
          }
        }
        recordAgentPointerFromToolResult(
          toolResult,
          matchedToolCall,
          deps.recordAgentPointer,
        );

        if (deps.isDev && !matched) {
          deps.warn('No matching toolCall found', { toolCallId: toolResult.toolCallId });
          deps.debug('Available toolCalls', {
            ids: deps.getMessages()
              .flatMap(m => m.toolCalls?.map(tc => tc.id) ?? [])
          });
        }

        deps.setActiveToolProgress(
          (prev) => prev?.toolCallId === toolResult.toolCallId ? null : prev,
        );
        deps.setToolTimeoutWarning(
          (prev) => prev?.toolCallId === toolResult.toolCallId ? null : prev,
        );
      }
      break;

    case 'tool_progress':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (event.data) {
        if (!isCurrentSessionEvent) {
          break;
        }
        deps.setActiveToolProgress(event.data as ToolProgressData);
      }
      break;

    case 'tool_output_delta':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (!isCurrentSessionEvent || !event.data?.toolCallId || !event.data?.content) {
        break;
      }
      {
        const delta = event.data as ToolOutputDeltaData;
        for (const msg of deps.getMessages()) {
          if (msg.role !== 'assistant' || !msg.toolCalls) continue;
          const hasMatch = msg.toolCalls.some((tc: ToolCall) => tc.id === delta.toolCallId);
          if (!hasMatch) continue;
          deps.updateMessage(msg.id, {
            toolCalls: applyToolOutputDelta(msg.toolCalls, delta, deps.now()),
          });
          break;
        }
      }
      break;

    case 'tool_timeout':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (event.data) {
        if (!isCurrentSessionEvent) {
          break;
        }
        deps.debug('tool_timeout', { data: event.data });
        deps.setToolTimeoutWarning(event.data as ToolTimeoutData);
      }
      break;

    case 'tool_call_local':
      deps.setLastEventAt(deps.now());
      logHandledEvent();
      if (!isCurrentSessionEvent) {
        break;
      }
      deps.dispatchBridgeToolCall(event.data);
      break;
  }
}

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
    const unsubscribe = ipcService.on('agent:event', (event: ToolExecutionEvent) => {
      applyToolExecutionEvent(event, {
        clearAgentPointers: () => useAgentPointerStore.getState().clearAll(),
        debug: (message, context) => logger.debug(message, context),
        dispatchBridgeToolCall: (data) => {
          window.dispatchEvent(new CustomEvent('bridge-tool-call', { detail: data }));
        },
        getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
        getCurrentTurnMessageId: () => currentTurnMessageIdRef.current,
        getMessages: () => useSessionStore.getState().messages,
        isDev: import.meta.env.DEV,
        now: Date.now,
        queueUpdate,
        recordAgentPointer: (event) => useAgentPointerStore.getState().recordEvent(event),
        setActiveToolProgress,
        setCapabilityGapNotice: (sessionId, notice) => {
          useCapabilityGapStore.getState().setNotice(sessionId, notice);
        },
        setLastEventAt: (timestamp) => {
          lastEventAtRef.current = timestamp;
        },
        setToolTimeoutWarning,
        updateMessage,
        warn: (message, context) => logger.warn(message, context),
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
    queueUpdate,
  ]);
};
