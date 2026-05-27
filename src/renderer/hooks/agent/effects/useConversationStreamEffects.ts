// useAgentConversationStreamEffects - turn_start, message_delta, message_snapshot, stream_chunk, stream_reasoning, turn_end, message, routing_resolved, hook_trigger
import { useEffect, useRef } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { ContentPart, HookTriggerEventData, Message, ToolCall } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTurnExecutionStore } from '../../../stores/turnExecutionStore';
import { useAppStore } from '../../../stores/appStore';
import { buildGoalNoticeMessage } from '../../../components/features/chat/goalNotice';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';

const logger = createLogger('useAgent');

type AgentEvent = { type: string; data?: unknown; sessionId?: string };

interface TurnIdPayload {
  turnId?: string;
}

interface StreamTextPayload extends TurnIdPayload {
  content: string;
}

interface MessageDeltaPayload extends TurnIdPayload {
  role: 'assistant';
  path: 'content' | 'reasoning';
  op: 'append' | 'replace';
  text: string;
  messageId?: string;
}

interface MessageSnapshotPayload extends TurnIdPayload {
  role: 'assistant';
  messageId?: string;
  content: string;
  reasoning?: string;
}

interface AssistantMessagePayload extends TurnIdPayload {
  id?: string;
  content?: string;
  toolCalls?: ToolCall[];
  contentParts?: ContentPart[];
}

interface RoutingResolvedPayload {
  mode: 'auto';
  timestamp?: number;
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  fallbackToDefault?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

function getBooleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeTurnIdPayload(data: unknown): TurnIdPayload {
  if (!isRecord(data)) return {};
  return {
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
  };
}

function normalizeStreamTextPayload(data: unknown): StreamTextPayload | null {
  if (!isRecord(data)) return null;
  const content = getStringField(data, 'content');
  if (content === undefined) return null;
  return {
    content,
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
  };
}

function normalizeMessageDeltaPayload(data: unknown): MessageDeltaPayload | null {
  if (!isRecord(data) || data.role !== 'assistant') return null;
  const text = getStringField(data, 'text');
  if (text === undefined) return null;
  return {
    role: 'assistant',
    path: data.path === 'reasoning' ? 'reasoning' : 'content',
    op: data.op === 'replace' ? 'replace' : 'append',
    text,
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getStringField(data, 'messageId') ? { messageId: getStringField(data, 'messageId') } : {}),
  };
}

function normalizeMessageSnapshotPayload(data: unknown): MessageSnapshotPayload | null {
  if (!isRecord(data) || data.role !== 'assistant') return null;
  const content = getStringField(data, 'content');
  if (content === undefined) return null;
  return {
    role: 'assistant',
    content,
    ...(getStringField(data, 'reasoning') ? { reasoning: getStringField(data, 'reasoning') } : {}),
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getStringField(data, 'messageId') ? { messageId: getStringField(data, 'messageId') } : {}),
  };
}

function normalizeToolCall(value: unknown): ToolCall | null {
  if (!isRecord(value)) return null;
  const id = getStringField(value, 'id');
  const name = getStringField(value, 'name');
  if (!id || !name) return null;

  return {
    ...value,
    id,
    name,
    arguments: isRecord(value.arguments) ? value.arguments : {},
  } as ToolCall;
}

function normalizeToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
}

function normalizeContentParts(value: unknown): ContentPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((raw): ContentPart[] => {
    if (!isRecord(raw)) return [];
    if (raw.type === 'text' && typeof raw.text === 'string') {
      return [{ type: 'text', text: raw.text }];
    }
    if (raw.type === 'tool_call' && typeof raw.toolCallId === 'string') {
      return [{ type: 'tool_call', toolCallId: raw.toolCallId }];
    }
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function normalizeAssistantMessagePayload(data: unknown): AssistantMessagePayload | null {
  if (!isRecord(data)) return null;
  const toolCalls = normalizeToolCalls(data.toolCalls);
  const contentParts = normalizeContentParts(data.contentParts);
  return {
    ...(getStringField(data, 'id') ? { id: getStringField(data, 'id') } : {}),
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getStringField(data, 'content') !== undefined ? { content: getStringField(data, 'content') } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(contentParts ? { contentParts } : {}),
  };
}

function normalizeRoutingResolvedPayload(data: unknown): RoutingResolvedPayload | null {
  if (!isRecord(data) || data.mode !== 'auto') return null;
  const agentId = getStringField(data, 'agentId');
  const agentName = getStringField(data, 'agentName');
  const reason = getStringField(data, 'reason');
  const score = getNumberField(data, 'score');
  if (!agentId || !agentName || !reason || score === undefined) return null;

  return {
    mode: 'auto',
    agentId,
    agentName,
    reason,
    score,
    ...(getNumberField(data, 'timestamp') !== undefined ? { timestamp: getNumberField(data, 'timestamp') } : {}),
    ...(getBooleanField(data, 'fallbackToDefault') !== undefined ? { fallbackToDefault: getBooleanField(data, 'fallbackToDefault') } : {}),
  };
}

function normalizeHookTriggerData(data: unknown): HookTriggerEventData | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const raw = data as Partial<HookTriggerEventData>;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((source): source is 'global' | 'project' => source === 'global' || source === 'project')
    : [];
  const hookType = raw.hookType === 'decision' || raw.hookType === 'observer'
    ? raw.hookType
    : 'observer';
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
    sources,
    hookType,
    ...(typeof raw.errorCount === 'number' ? { errorCount: raw.errorCount } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
    ...(typeof raw.matcher === 'string' ? { matcher: raw.matcher } : {}),
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
  appendStreamingMessageDelta?: (messageId: string, delta: { content?: string; reasoning?: string }) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setMessages: (messages: Message[]) => void;
  getMessages: () => Message[];
  queueUpdate: (update: Parameters<AgentEffectsProps['queueUpdate']>[0]) => void;
  now?: () => number;
  generateId?: () => string;
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
        const targetMessageId = chunkData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          appendAssistantStreamDelta(actions, targetMessage.id, {
            content: chunkData.content,
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

    case 'message':
      {
        const messageData = normalizeAssistantMessagePayload(event.data);
        if (!messageData) break;
        const targetMessageId = messageData.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

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
            // 采用服务端已算好的交错顺序（text/tool_call 块），让 AssistantMessage 走
            // ContentPartsRenderer 而非 fallback。fallback 永远把正文渲染在工具组之上，
            // 会把"先搜索后总结"这类时序倒过来（WebSearch 折叠块落到答案下方）。
            // 仅在事件带 contentParts 时覆盖，纯文本/纯工具轮次保持原有 fallback。
            ...(messageData.contentParts ? { contentParts: messageData.contentParts } : {}),
          });
        }
      }
      break;

    case 'stream_reasoning':
      {
        const reasoningData = normalizeStreamTextPayload(event.data);
        if (!reasoningData?.content) break;
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
      const eventSessionId = event.sessionId || currentSessionId || null;
      const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;
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
            const d = event.data as { turn: number; maxTurns: number; tokensUsed: number; tokenBudget: number };
            useAppStore.getState().updateGoalProgress(eventSessionId, {
              turn: d.turn,
              maxTurns: d.maxTurns,
              tokensUsed: d.tokensUsed,
              tokenBudget: d.tokenBudget,
            });
          }
          break;
        }

        case 'goal_gate': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { gate: number; pass: boolean; reason?: string };
            useAppStore.getState().recordGoalGate(eventSessionId, {
              gate: d.gate,
              pass: d.pass,
              reason: d.reason,
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
