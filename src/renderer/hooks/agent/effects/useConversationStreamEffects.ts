// useAgentConversationStreamEffects - turn_start, stream_chunk, stream_reasoning, turn_end, message, routing_resolved
import { useEffect } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message, ToolCall } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTurnExecutionStore } from '../../../stores/turnExecutionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');

type AgentEvent = { type: string; data: any; sessionId?: string };

export const useConversationStreamEffects = ({
  addMessage,
  currentTurnMessageIdRef,
  flushRef,
  lastEventAtRef,
  queueUpdate,
  updateMessage,
  setTodos,
  setIsProcessing,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
  setSessionTaskProgress,
  setSessionTaskComplete,
}: AgentEffectsProps) => {
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const eventSessionId = event.sessionId || currentSessionId || null;
      const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;
      const getFreshMessages = () => useSessionStore.getState().messages;
      const logHandledEvent = () => {
        const silentEvents = ['stream_chunk', 'stream_reasoning'];
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

        case 'turn_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          {
            const turnId = event.data?.turnId || generateMessageId();
            const newMessage: Message = {
              id: turnId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              toolCalls: [],
            };
            addMessage(newMessage);
            currentTurnMessageIdRef.current = turnId;
            logger.debug('turn_start - created message', { turnId, sessionId: eventSessionId });
          }
          break;

        case 'stream_chunk':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data?.content) {
            const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
            const freshMsgs = getFreshMessages();
            const targetMessage = targetMessageId
              ? freshMsgs.find(m => m.id === targetMessageId)
              : freshMsgs[freshMsgs.length - 1];

            if (targetMessage?.role === 'assistant') {
              queueUpdate({
                type: 'append',
                messageId: targetMessage.id,
                content: event.data.content,
              });
            } else {
              const lastMessage = getFreshMessages()[getFreshMessages().length - 1];
              if (lastMessage?.role === 'assistant') {
                const hasCompletedToolCalls = lastMessage.toolCalls?.some(
                  (tc: ToolCall) => tc.result !== undefined
                );
                if (hasCompletedToolCalls) {
                  const newMessage: Message = {
                    id: generateMessageId(),
                    role: 'assistant',
                    content: event.data.content,
                    timestamp: Date.now(),
                    toolCalls: [],
                  };
                  addMessage(newMessage);
                  currentTurnMessageIdRef.current = newMessage.id;
                } else {
                  queueUpdate({
                    type: 'append',
                    messageId: lastMessage.id,
                    content: event.data.content,
                  });
                }
              }
            }
          }
          break;

        case 'message':
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

            if (targetMessage?.role === 'assistant') {
              const existingContent = targetMessage.content || '';
              const newContent = event.data.content || '';

              let mergedToolCalls = targetMessage.toolCalls;
              if (event.data.toolCalls && event.data.toolCalls.length > 0) {
                const existingToolCalls = targetMessage.toolCalls || [];
                if (existingToolCalls.length > 0) {
                  // streaming 期间 in-memory ToolCall 缺产品视角语义字段（_meta envelope
                  // 抽取在前端 stream_tool_call_delta 已尽力，但模型不 emit 时仍空），
                  // message 事件传来的版本经过 main 进程 sanitize / 兜底，shortDescription
                  // 等字段更完整。把这些字段 merge 进 existing，但保留 streaming 时
                  // 已经写好的 result。
                  const fromEvent = new Map<string, ToolCall>(
                    event.data.toolCalls.map((tc: ToolCall) => [tc.id, tc] as [string, ToolCall]),
                  );
                  mergedToolCalls = existingToolCalls.map((existing: ToolCall) => {
                    const fresh = fromEvent.get(existing.id);
                    if (!fresh) return existing;
                    return {
                      ...existing,
                      shortDescription: fresh.shortDescription ?? existing.shortDescription,
                      targetContext: fresh.targetContext ?? existing.targetContext,
                      expectedOutcome: fresh.expectedOutcome ?? existing.expectedOutcome,
                      // arguments 用 main 进程 sanitize 过的版本（已剥 _meta、过滤敏感）
                      arguments: fresh.arguments ?? existing.arguments,
                    };
                  });
                  // 追加 event 中存在但 existing 没有的（极少见，但保住兼容）
                  const existingIds = new Set(existingToolCalls.map((tc: ToolCall) => tc.id));
                  const newOnes = event.data.toolCalls.filter(
                    (tc: ToolCall) => !existingIds.has(tc.id)
                  );
                  if (newOnes.length > 0) {
                    mergedToolCalls = [...mergedToolCalls, ...newOnes];
                  }
                } else {
                  mergedToolCalls = event.data.toolCalls;
                }
              }

              updateMessage(targetMessage.id, {
                content: existingContent.length >= newContent.length ? existingContent : newContent,
                toolCalls: mergedToolCalls,
              });
            }
          }
          break;

        case 'turn_end':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          flushRef.current();
          logger.debug('turn_end', { turnId: event.data?.turnId });
          break;

        case 'routing_resolved':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (eventSessionId && event.data?.mode === 'auto') {
            useTurnExecutionStore.getState().recordRoutingEvidence(eventSessionId, {
              kind: 'auto',
              mode: 'auto',
              timestamp: event.data.timestamp || Date.now(),
              agentId: event.data.agentId,
              agentName: event.data.agentName,
              reason: event.data.reason,
              score: event.data.score,
              fallbackToDefault: event.data.fallbackToDefault,
            });
          }
          break;

        case 'stream_reasoning':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data?.content) {
            const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
            const targetMessage = targetMessageId
              ? getFreshMessages().find(m => m.id === targetMessageId)
              : getFreshMessages()[getFreshMessages().length - 1];

            if (targetMessage?.role === 'assistant') {
              queueUpdate({
                type: 'append',
                messageId: targetMessage.id,
                reasoning: event.data.content,
              });
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
