// useAgentConversationStreamEffects - turn_start, message_delta, message_snapshot, stream_chunk, stream_reasoning, turn_end, message, model_decision, routing_resolved, hook_trigger
import { useEffect, useRef } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message, ToolCall } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useStatusStore } from '../../../stores/statusStore';
import { useTurnExecutionStore } from '../../../stores/turnExecutionStore';
import { applyRoutingDegradationSignal } from '../../../utils/routingDegradation';
import { useAppStore } from '../../../stores/appStore';
import { useTaskStore } from '../../../stores/taskStore';
import { languages } from '../../../i18n';
import { resolveHostReasonCopy } from '../../../utils/hostReasonPresentation';
import {
  projectGoalCompletePresentation,
  type GoalCompletePresentationData,
} from '../../../utils/goalCompletePresentation';
import { remainingAssistantStreamDelta } from '../../../utils/assistantStreamDelta';

/**
 * 这些 agent 事件不构成「宿主还在跑」的证据：终态由各自分支负责把运行态放下，
 * 在这里抢先点亮会让刚结束的轮次又闪一下运行中。
 */
const LIVE_STATE_NEUTRAL_AGENT_EVENTS: ReadonlySet<string> = new Set([
  'agent_complete',
  'agent_cancelled',
  'subagent_run_end',
  'error',
  'input_redirected',
]);
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
  normalizeHookStartedData,
  normalizeHookTriggerData,
  normalizeMessageDeltaPayload,
  normalizeMessageSnapshotPayload,
  normalizeModelDecisionPayload,
  normalizeModelFallbackPayload,
  normalizeRoutingResolvedPayload,
  normalizeStreamTextPayload,
  normalizeTurnIdPayload,
  normalizeUserMessagePayload,
} from './streamEventNormalizers';

const logger = createLogger('useAgent');

/**
 * 清掉「什么都没产出」的空草稿气泡（轮次起了个头就被打断/换轮）。
 *
 * 只清空的：已经吐到屏幕上的字**不许删**。停止那一刻横幅明写「已经写出来的内容
 * 保留在上面」，而这个函数把 491 字的半截回答连同气泡一起删了，上面什么都不剩
 * ——当着用户面许一个看得见的空头承诺（2026-08-01 真机 2/2）。宿主侧现在停止和
 * 转向都会把半截内容落库，屏幕留住它才和数据层一致。
 */
export function removeUncommittedAssistantDraft(
  messages: Message[],
  draftMessageId: string | null | undefined,
): Message[] {
  if (!draftMessageId) return messages;

  const draft = messages.find((message) => message.id === draftMessageId);
  if (draft?.role !== 'assistant') return messages;

  const hasToolCalls = (draft.toolCalls?.length || 0) > 0;
  if (hasToolCalls) return messages;

  const hasVisibleOutput = Boolean(
    draft.content?.trim() || draft.reasoning?.trim() || draft.thinking?.trim(),
  );
  if (hasVisibleOutput) return messages;

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

/** 与 host 的 messageDeltaAccumulator.acceptDelta 同一口径：序号回头即重放，无序号放行。 */
function acceptDeltaSeq(
  state: ConversationStreamState,
  turnKey: string | null | undefined,
  deltaSeq: unknown,
): boolean {
  if (typeof deltaSeq !== 'number' || !turnKey) return true;
  const seen = state.lastDeltaSeqByTurn;
  const last = seen.get(turnKey);
  if (last !== undefined && deltaSeq <= last) return false;
  seen.set(turnKey, deltaSeq);
  return true;
}

export interface ConversationStreamState {
  currentTurnMessageId: string | null;
  committedAssistantMessageIds: Set<string>;
  /**
   * 每个 turn 已应用到的最大 deltaSeq。重连/重放会把已经应用过的 chunk 原样再送一遍，
   * 而**字符串比对判不了重放**：合法的重复正文（连着两段一模一样的长文）与重放长得一样，
   * 按内容丢就会吞掉真内容（ai-review #1696 两轮各撞一次：前缀裁剪丢字、整段全等吞段）。
   * 事件本来就带 deltaSeq，host 侧 messageDeltaAccumulator.acceptDelta 早就是这么判的，
   * 渲染层照抄同一口径：序号回头就是重放，没有序号才回落到内容判定。
   */
  lastDeltaSeqByTurn: Map<string, number>;
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
    case 'input_redirected':
      // 事件继续供账本 / Inspector / trace 消费；聊天流由用户原话气泡和助理正文承接。
      break;

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
        const existing = getFreshMessages().find((message) => message.id === turnId);
        if (existing?.role === 'assistant') {
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
        // 序号回头 = 重连重放，整条丢；有序号时不再看内容（内容判不了重放）。
        if (!acceptDeltaSeq(state, targetMessageId, (event.data as { deltaSeq?: unknown } | undefined)?.deltaSeq)) break;
        const hasDeltaSeq = typeof (event.data as { deltaSeq?: unknown } | undefined)?.deltaSeq === 'number';
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          const remaining = hasDeltaSeq
            ? chunkData.content
            : remainingAssistantStreamDelta(targetMessage.content || '', chunkData.content);
          if (!remaining) break;
          appendAssistantStreamDelta(actions, targetMessage.id, {
            content: remaining,
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
              const remaining = hasDeltaSeq
                ? chunkData.content
                : remainingAssistantStreamDelta(lastMessage.content || '', chunkData.content);
              if (!remaining) break;
              appendAssistantStreamDelta(actions, lastMessage.id, {
                content: remaining,
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
        // 生产里真正带 deltaSeq 的就是这条分支（eventBatcher 只在 message_delta 上透传），
        // 序号去重必须接在这里，接漏了等于没接（ai-review #1696 第三轮）。
        const deltaSeq = (event.data as { deltaSeq?: unknown } | undefined)?.deltaSeq;
        if (!acceptDeltaSeq(state, targetMessageId, deltaSeq)) break;
        const deltaHasSeq = typeof deltaSeq === 'number';
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
            const existing = field === 'reasoning'
              ? (targetMessage.reasoning || '')
              : (targetMessage.content || '');
            const remaining = deltaHasSeq
              ? deltaData.text
              : remainingAssistantStreamDelta(existing, deltaData.text);
            if (!remaining) break;
            appendAssistantStreamDelta(actions, targetMessage.id, field === 'reasoning'
              ? { reasoning: remaining }
              : { content: remaining });
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
        // 本轮实际模型 → statusStore，供 stream_usage 的费用估算归因（该事件不带模型）
        useStatusStore.getState().setCurrentTurnModel({
          provider: decisionData.resolvedProvider,
          model: decisionData.resolvedModel,
        });
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

    // provider usage → 本轮费用估算（此前该事件只有 CLI 消费，桌面端直接丢弃）
    case 'stream_usage':
      {
        const usage = isRecord(event.data) ? event.data : undefined;
        const inputTokens = usage?.inputTokens;
        const outputTokens = usage?.outputTokens;
        if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
          useStatusStore.getState().recordTurnUsage({ inputTokens, outputTokens });
        }
      }
      break;

    case 'message':
      {
        // 宿主自起轮次的用户气泡（抽干排队消息 / 断连后续跑）：这条消息前端没有
        // 本地副本，只能从宿主接。按 id 幂等——直连轮不会走到这里，即便重复到达
        // 也不会多出一个气泡。
        const userMessage = normalizeUserMessagePayload(event.data);
        if (userMessage) {
          if (!getFreshMessages().some((message) => message.id === userMessage.id)) {
            actions.addMessage({
              id: userMessage.id,
              role: 'user',
              content: userMessage.content,
              timestamp: userMessage.timestamp ?? now(),
              ...(userMessage.attachments ? { attachments: userMessage.attachments } : {}),
              ...(userMessage.metadata ? { metadata: userMessage.metadata } : {}),
            });
          }
          break;
        }

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
                  stepLabel: fresh.stepLabel ?? existing.stepLabel,
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
          const remaining = remainingAssistantStreamDelta(
            targetMessage.reasoning || '',
            reasoningData.content,
          );
          if (!remaining) break;
          appendAssistantStreamDelta(actions, targetMessage.id, {
            reasoning: remaining,
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
  // 🔴 必须挂 ref：下面四个调用点的 state 是**每次现造的对象字面量**，把 Map 挂在它身上
  // 等于每次调用都丢一次（ai-review #1696 第三轮抓到；我的单测复用了同一个 state 对象，
  // 夹具寿命与生产不一致所以照样绿——这类断言必须让夹具跟生产同寿命）。
  const lastDeltaSeqByTurnRef = useRef<Map<string, number>>(new Map());

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

      // 以宿主为准补齐运行态：只要收到一个属于某会话的「还在跑」类事件，而前端却认为它空闲，
      // 那就是前端错了——轮次不一定由前端发起（队列抽干、崩溃恢复、别的窗口）。
      //
      // 不能只认 turn_start：刷新后是全新页面，没有 Last-Event-ID 就不重放，turn_start
      // 往往在 SSE 连上之前就广播完了，新页面只接得到中段的增量事件（2026-08-01 C3 真机：
      // 刷新后宿主 drain 起的那一轮全程在写库，屏幕却一直空闲、排队卡还邀请你「立即发送」）。
      // 终态事件不在此列——它们由各自分支负责把运行态放下。
      if (
        eventSessionId
        && !LIVE_STATE_NEUTRAL_AGENT_EVENTS.has(event.type)
        && !useAppStore.getState().isSessionProcessing(eventSessionId)
      ) {
        useAppStore.getState().setSessionProcessing(eventSessionId, true);
        useTaskStore.getState().updateSessionState(eventSessionId, { status: 'running' });
      }

      switch (event.type) {
        case 'agent_complete':
        case 'agent_cancelled':
        case 'error':
        case 'stream_end':
          // running 兜底：agent 终态/错误后不会再有配对的 hook_trigger，撤下悬挂的指示
          if (eventSessionId) {
            useTurnExecutionStore.getState().clearHookRunning(eventSessionId);
          }
          flushRef.current();
          flushStreamingMessages();
          return;

        // /goal 自治模式：进度 / 闸判定 / 终态（per-session 更新 appStore；终态在当前会话补一条生命周期消息）
        // 注：本文件的 event 是 loose 类型（data?: unknown），按 contract 的 AgentEvent 形状断言。
        case 'goal_iteration': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { turn: number; maxTurns: number; goalStatus: 'pending' | 'paused'; pauseReason?: 'anti_spin'; tokensUsed: number; tokenBudget: number; wallClockBudgetMs?: number };
            useAppStore.getState().updateGoalProgress(eventSessionId, {
              turn: d.turn,
              maxTurns: d.maxTurns,
              tokensUsed: d.tokensUsed,
              tokenBudget: d.tokenBudget,
              wallClockBudgetMs: d.wallClockBudgetMs,
            });
            useAppStore.getState().setGoalPaused(eventSessionId, d.goalStatus === 'paused', d.pauseReason);
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
            const d = event.data as GoalCompletePresentationData;
            const appStore = useAppStore.getState();
            const run = appStore.goalRuns[eventSessionId];
            const presentation = projectGoalCompletePresentation(
              d,
              run,
              languages[appStore.language],
            );
            appStore.finishGoalRun(eventSessionId, d.status, presentation.stateReason, d.degraded);
            if (isCurrentSessionEvent && presentation.notice) {
              addMessage(buildGoalNoticeMessage(presentation.notice));
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
              lastDeltaSeqByTurn: lastDeltaSeqByTurnRef.current,
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
        case 'stream_usage':
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
              lastDeltaSeqByTurn: lastDeltaSeqByTurnRef.current,
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
              lastDeltaSeqByTurn: lastDeltaSeqByTurnRef.current,
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

        case 'input_redirected':
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
              lastDeltaSeqByTurn: lastDeltaSeqByTurnRef.current,
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
          // running 兜底：本轮结束（含被取消/报错收尾）后不应再有在跑的 hook 批次
          if (eventSessionId) {
            useTurnExecutionStore.getState().clearHookRunning(eventSessionId);
          }
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
            const routingReason = resolveHostReasonCopy(
              routingData.reason,
              languages[useAppStore.getState().language],
            );
            useTurnExecutionStore.getState().recordRoutingEvidence(eventSessionId, {
              kind: 'auto',
              mode: routingData.mode,
              timestamp: routingData.timestamp || Date.now(),
              agentId: routingData.agentId,
              agentName: routingData.agentName,
              reason: routingReason?.summary ?? languages[useAppStore.getState().language].agentError.categories.generic.title,
              score: routingData.score,
              fallbackToDefault: routingData.fallbackToDefault,
              requestedAgentId: routingData.requestedAgentId,
            });
            // S2 显式化：显式选择未生效（requested ≠ actual）→ 清 per-session 选择 + toast 警示
            applyRoutingDegradationSignal(eventSessionId, routingData);
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
              lastDeltaSeqByTurn: lastDeltaSeqByTurnRef.current,
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

        case 'hook_started':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          {
            const hookStart = normalizeHookStartedData(event.data);
            if (eventSessionId && hookStart) {
              useTurnExecutionStore.getState().recordHookStart(eventSessionId, hookStart);
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
              lastDeltaSeqByTurn: lastDeltaSeqByTurnRef.current,
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
