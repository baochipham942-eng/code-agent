// useAgentConversationStreamEffects - turn_start, stream_chunk, stream_reasoning, turn_end, message, routing_resolved, hook_trigger
import { useEffect, useRef } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { HookTriggerEventData, Message, ToolCall } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTurnExecutionStore } from '../../../stores/turnExecutionStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): AgentEvent 在 5 个 hook 文件里各自重复定义且都用 any，应抽成 shared 类型，data 形态由 type 决定（stream_chunk/tool_call/error 等），按 type narrow
type AgentEvent = { type: string; data: any; sessionId?: string };

function normalizeHookTriggerData(data: unknown): HookTriggerEventData | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const raw = data as Partial<HookTriggerEventData>;
  if (
    typeof raw.timestamp !== 'number'
    || typeof raw.event !== 'string'
    || (raw.action !== 'allow' && raw.action !== 'block')
    || typeof raw.durationMs !== 'number'
    || typeof raw.hookCount !== 'number'
  ) {
    return null;
  }

  return {
    timestamp: raw.timestamp,
    event: raw.event,
    action: raw.action,
    durationMs: raw.durationMs,
    hookCount: raw.hookCount,
    modified: Boolean(raw.modified),
    ...(typeof raw.errorCount === 'number' ? { errorCount: raw.errorCount } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
  };
}

export function removeUncommittedAssistantDraft(
  messages: Message[],
  draftMessageId: string | null | undefined,
): Message[] {
  if (!draftMessageId) return messages;

  const draft = messages.find((message) => message.id === draftMessageId);
  if (draft?.role !== 'assistant') return messages;

  const hasToolCalls = (draft.toolCalls?.length || 0) > 0;
  if (hasToolCalls) return messages;

  return messages.filter((message) => message.id !== draftMessageId);
}

export function mergeCommittedAssistantContent(
  existingContent: string,
  committedContent: string,
): string {
  if (!committedContent) return existingContent;
  if (!existingContent) return committedContent;
  if (existingContent === committedContent) return existingContent;
  return committedContent;
}

export interface ConversationStreamState {
  currentTurnMessageId: string | null;
  committedAssistantMessageIds: Set<string>;
}

interface ConversationStreamEventActions {
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setMessages: (messages: Message[]) => void;
  getMessages: () => Message[];
  queueUpdate: (update: Parameters<AgentEffectsProps['queueUpdate']>[0]) => void;
  now?: () => number;
  generateId?: () => string;
}

export function applyConversationStreamEvent(
  event: AgentEvent,
  state: ConversationStreamState,
  actions: ConversationStreamEventActions,
): void {
  const now = actions.now ?? Date.now;
  const makeId = actions.generateId ?? generateMessageId;
  const getFreshMessages = actions.getMessages;

  switch (event.type) {
    case 'turn_start':
      if (
        state.currentTurnMessageId &&
        !state.committedAssistantMessageIds.has(state.currentTurnMessageId)
      ) {
        const messages = getFreshMessages();
        const cleanedMessages = removeUncommittedAssistantDraft(
          messages,
          state.currentTurnMessageId,
        );
        if (cleanedMessages !== messages) {
          actions.setMessages(cleanedMessages);
        }
      }

      {
        const turnId = event.data?.turnId || makeId();
        const newMessage: Message = {
          id: turnId,
          role: 'assistant',
          content: '',
          timestamp: now(),
          toolCalls: [],
        };
        actions.addMessage(newMessage);
        state.currentTurnMessageId = turnId;
        state.committedAssistantMessageIds.delete(turnId);
      }
      break;

    case 'stream_chunk':
      if (event.data?.content) {
        const targetMessageId = event.data.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          actions.queueUpdate({
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
                id: makeId(),
                role: 'assistant',
                content: event.data.content,
                timestamp: now(),
                toolCalls: [],
              };
              actions.addMessage(newMessage);
              state.currentTurnMessageId = newMessage.id;
              state.committedAssistantMessageIds.delete(newMessage.id);
            } else {
              actions.queueUpdate({
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
      if (event.data) {
        const targetMessageId = event.data.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (targetMessage?.role === 'assistant') {
          state.committedAssistantMessageIds.add(targetMessage.id);
          if (event.data.id) {
            state.committedAssistantMessageIds.add(event.data.id);
          }

          const existingContent = targetMessage.content || '';
          const newContent = event.data.content || '';

          let mergedToolCalls = targetMessage.toolCalls;
          if (event.data.toolCalls && event.data.toolCalls.length > 0) {
            const existingToolCalls = targetMessage.toolCalls || [];
            if (existingToolCalls.length > 0) {
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
                  arguments: fresh.arguments ?? existing.arguments,
                };
              });
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

          actions.updateMessage(targetMessage.id, {
            content: mergeCommittedAssistantContent(existingContent, newContent),
            toolCalls: mergedToolCalls,
          });
        }
      }
      break;

    case 'stream_reasoning':
      if (event.data?.content) {
        const targetMessageId = event.data.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (targetMessage?.role === 'assistant') {
          actions.queueUpdate({
            type: 'append',
            messageId: targetMessage.id,
            reasoning: event.data.content,
          });
        }
      }
      break;
  }
}

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
  const committedAssistantMessageIdsRef = useRef<Set<string>>(new Set());

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
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          logger.debug('turn_start - created message', { turnId: currentTurnMessageIdRef.current, sessionId: eventSessionId });
          break;

        case 'stream_chunk':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          break;

        case 'message':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          flushRef.current();
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
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

        case 'hook_trigger':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          {
            const hookData = normalizeHookTriggerData(event.data);
            if (eventSessionId && hookData) {
              useTurnExecutionStore.getState().recordHookActivity(eventSessionId, hookData);
            }
          }
          break;

        case 'stream_reasoning':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
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
