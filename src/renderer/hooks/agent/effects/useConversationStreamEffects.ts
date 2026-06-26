// useAgentConversationStreamEffects - turn_start, message_delta, message_snapshot, stream_chunk, stream_reasoning, turn_end, message, model_decision, routing_resolved, hook_trigger
import { useEffect, useRef } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message, ToolCall } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTurnExecutionStore } from '../../../stores/turnExecutionStore';
import { useAppStore } from '../../../stores/appStore';
import { buildGoalNoticeMessage } from '../../../components/features/chat/goalNotice';
import { buildModelFallbackNoticeMessage } from '../../../components/features/chat/fallbackNotice';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';
import type { AgentEvent, ConversationStreamEventActions } from './streamEventTypes';
import {
  getBooleanField,
  isRecord,
  normalizeAssistantMessagePayload,
  normalizeHookTriggerData,
  normalizeMessageDeltaPayload,
  normalizeMessageSnapshotPayload,
  normalizeModelDecisionPayload,
  normalizeModelFallbackPayload,
  normalizeRoutingResolvedPayload,
  normalizeStreamTextPayload,
  normalizeTurnIdPayload,
} from './streamEventNormalizers';

const logger = createLogger('useAgent');

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

function appendAssistantStreamDelta(
  actions: ConversationStreamEventActions,
  messageId: string,
  delta: { content?: string; reasoning?: string },
): void {
  if (actions.appendStreamingMessageDelta) {
    actions.appendStreamingMessageDelta(messageId, delta);
    return;
  }

  actions.queueUpdate({
    type: 'append',
    messageId,
    ...delta,
  });
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
        const turnData = normalizeTurnIdPayload(event.data);
        const turnId = turnData.turnId || makeId();
        if (turnData.isMeta) {
          state.currentTurnMessageId = turnId;
          state.committedAssistantMessageIds.delete(turnId);
          break;
        }
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
      {
        const chunkData = normalizeStreamTextPayload(event.data);
        if (!chunkData?.content) break;
        if (chunkData.isMeta) break;
        const targetMessageId = chunkData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          appendAssistantStreamDelta(actions, targetMessage.id, {
            content: chunkData.content,
          });
        } else if (targetMessageId) {
          break;
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
                content: chunkData.content,
                timestamp: now(),
                toolCalls: [],
              };
              actions.addMessage(newMessage);
              state.currentTurnMessageId = newMessage.id;
              state.committedAssistantMessageIds.delete(newMessage.id);
            } else {
              appendAssistantStreamDelta(actions, lastMessage.id, {
                content: chunkData.content,
              });
            }
          }
        }
      }
      break;

    case 'message_delta':
      {
        const deltaData = normalizeMessageDeltaPayload(event.data);
        if (!deltaData?.text) break;
        if (deltaData.isMeta) break;
        const targetMessageId = deltaData.messageId || deltaData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          const field = deltaData.path === 'reasoning' ? 'reasoning' : 'content';
          if (deltaData.op === 'replace') {
            actions.updateMessage(targetMessage.id, field === 'reasoning'
              ? { reasoning: deltaData.text }
              : { content: deltaData.text });
          } else {
            appendAssistantStreamDelta(actions, targetMessage.id, field === 'reasoning'
              ? { reasoning: deltaData.text }
              : { content: deltaData.text });
          }
        }
      }
      break;

    case 'message_snapshot':
      {
        const snapshotData = normalizeMessageSnapshotPayload(event.data);
        if (!snapshotData) break;
        if (snapshotData.isMeta) break;
        const targetMessageId = snapshotData.turnId || snapshotData.messageId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          actions.updateMessage(targetMessage.id, {
            content: snapshotData.content,
            reasoning: snapshotData.reasoning,
          });
        }
      }
      break;

    case 'model_decision':
      {
        const decisionData = normalizeModelDecisionPayload(event.data);
        if (!decisionData) break;
        if (isRecord(event.data) && getBooleanField(event.data, 'isMeta')) break;
        const targetMessageId = decisionData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          actions.updateMessage(targetMessage.id, {
            modelDecision: decisionData,
          });
        }
      }
      break;

    case 'model_fallback':
      {
        const fallbackData = normalizeModelFallbackPayload(event.data);
        if (!fallbackData) break;
        actions.addMessage(buildModelFallbackNoticeMessage(fallbackData));
      }
      break;

    case 'message':
      {
        const messageData = normalizeAssistantMessagePayload(event.data);
        if (!messageData) break;
        const targetMessageId = messageData.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (messageData.isMeta) {
          if (targetMessage?.role === 'assistant') {
            actions.setMessages(getFreshMessages().filter((message) => message.id !== targetMessage.id));
          }
          if (targetMessageId) {
            state.committedAssistantMessageIds.add(targetMessageId);
          }
          if (messageData.id) {
            state.committedAssistantMessageIds.add(messageData.id);
          }
          break;
        }

        if (targetMessage?.role === 'assistant') {
          state.committedAssistantMessageIds.add(targetMessage.id);
          if (messageData.id) {
            state.committedAssistantMessageIds.add(messageData.id);
          }

          const existingContent = targetMessage.content || '';
          const newContent = messageData.content || '';

          let mergedToolCalls = targetMessage.toolCalls;
          if (messageData.toolCalls && messageData.toolCalls.length > 0) {
            const existingToolCalls = targetMessage.toolCalls || [];
            if (existingToolCalls.length > 0) {
              const fromEvent = new Map<string, ToolCall>(
                messageData.toolCalls.map((tc: ToolCall) => [tc.id, tc] as [string, ToolCall]),
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
              const newOnes = messageData.toolCalls.filter(
                (tc: ToolCall) => !existingIds.has(tc.id)
              );
              if (newOnes.length > 0) {
                mergedToolCalls = [...mergedToolCalls, ...newOnes];
              }
            } else {
              mergedToolCalls = messageData.toolCalls;
            }
          }

          actions.updateMessage(targetMessage.id, {
            content: mergeCommittedAssistantContent(existingContent, newContent),
            toolCalls: mergedToolCalls,
            ...(messageData.reasoning !== undefined ? { reasoning: messageData.reasoning } : {}),
            ...(messageData.thinking !== undefined ? { thinking: messageData.thinking } : {}),
            ...(messageData.isMeta !== undefined ? { isMeta: messageData.isMeta } : {}),
            ...(messageData.contentParts ? { contentParts: messageData.contentParts } : {}),
            ...(messageData.artifacts ? { artifacts: messageData.artifacts } : {}),
            ...(messageData.modelDecision ? { modelDecision: messageData.modelDecision } : {}),
          });
        }
      }
      break;

    case 'stream_reasoning':
      {
        const reasoningData = normalizeStreamTextPayload(event.data);
        if (!reasoningData?.content) break;
        if (reasoningData.isMeta) break;
        const targetMessageId = reasoningData.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (targetMessage?.role === 'assistant') {
          appendAssistantStreamDelta(actions, targetMessage.id, {
            reasoning: reasoningData.content,
          });
        }
      }
      break;
  }
}

export const useConversationStreamEffects = ({
  addMessage,
  appendStreamingMessageDelta,
  currentTurnMessageIdRef,
  flushStreamingMessages,
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
      const eventSessionId = getAgentEventSessionId(event);
      const isCurrentSessionEvent = isAgentEventForCurrentSession(event, currentSessionId);
      const getFreshMessages = () => useSessionStore.getState().messages;
      const logHandledEvent = () => {
        const silentEvents = ['message_delta', 'message_snapshot', 'stream_chunk', 'stream_reasoning'];
        if (!silentEvents.includes(event.type)) {
          logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
        }
      };

      switch (event.type) {
        case 'agent_complete':
        case 'agent_cancelled':
        case 'error':
        case 'stream_end':
          flushRef.current();
          flushStreamingMessages();
          return;

        // /goal 自治模式：进度 / 闸判定 / 终态（per-session 更新 appStore；终态在当前会话补一条生命周期消息）
        // 注：本文件的 event 是 loose 类型（data?: unknown），按 contract 的 AgentEvent 形状断言。
        case 'goal_iteration': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { turn: number; maxTurns: number; tokensUsed: number; tokenBudget: number; wallClockBudgetMs?: number };
            useAppStore.getState().updateGoalProgress(eventSessionId, {
              turn: d.turn,
              maxTurns: d.maxTurns,
              tokensUsed: d.tokensUsed,
              tokenBudget: d.tokenBudget,
              wallClockBudgetMs: d.wallClockBudgetMs,
            });
          }
          break;
        }

        case 'goal_gate': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as {
              gate: number;
              pass: boolean;
              reason?: string;
              verificationCard?: import('@shared/contract/agent').GoalGateVerificationCard;
            };
            useAppStore.getState().recordGoalGate(eventSessionId, {
              gate: d.gate,
              pass: d.pass,
              reason: d.reason,
              verificationCard: d.verificationCard,
            });
          }
          break;
        }

        case 'goal_complete': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { status: 'met' | 'aborted'; reason?: string; turns: number; tokensUsed: number };
            const appStore = useAppStore.getState();
            const run = appStore.goalRuns[eventSessionId];
            appStore.finishGoalRun(eventSessionId, d.status, d.reason);
            if (isCurrentSessionEvent) {
              addMessage(buildGoalNoticeMessage({
                kind: d.status === 'met' ? 'met' : 'aborted',
                goal: run?.goal ?? '',
                reason: d.reason,
                turns: d.turns,
                tokensUsed: d.tokensUsed,
                durationMs: run ? Date.now() - run.startedAt : undefined,
                verificationCard: [...(run?.gates ?? [])].reverse().find((gate) => gate.verificationCard)?.verificationCard,
              }));
            }
          }
          break;
        }

        case 'turn_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          flushRef.current();
          flushStreamingMessages();
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
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          logger.debug('turn_start - created message', { turnId: currentTurnMessageIdRef.current, sessionId: eventSessionId });
          break;

        case 'stream_chunk':
        case 'message_delta':
        case 'message_snapshot':
        case 'model_decision':
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
              appendStreamingMessageDelta,
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
          flushStreamingMessages();
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
              appendStreamingMessageDelta,
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
          flushStreamingMessages();
          logger.debug('turn_end', { turnId: normalizeTurnIdPayload(event.data).turnId });
          break;

        case 'routing_resolved':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          {
            const routingData = normalizeRoutingResolvedPayload(event.data);
            if (!eventSessionId || !routingData) {
              break;
            }
            useTurnExecutionStore.getState().recordRoutingEvidence(eventSessionId, {
              kind: 'auto',
              mode: 'auto',
              timestamp: routingData.timestamp || Date.now(),
              agentId: routingData.agentId,
              agentName: routingData.agentName,
              reason: routingData.reason,
              score: routingData.score,
              fallbackToDefault: routingData.fallbackToDefault,
            });
          }
          break;

        case 'model_fallback':
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
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
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
              appendStreamingMessageDelta,
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
    appendStreamingMessageDelta,
    setTodos,
    setIsProcessing,
    setPendingPermissionRequest,
    enqueuePermissionRequest,
    setSessionTaskProgress,
    setSessionTaskComplete,
    flushRef,
    flushStreamingMessages,
    queueUpdate,
    addMessage,
    currentTurnMessageIdRef,
    lastEventAtRef,
  ]);
};
