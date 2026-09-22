// useAgentConversationStreamEffects - turn_start, message_delta, message_snapshot, stream_chunk, stream_reasoning, turn_end, message, model_decision, routing_resolved, hook_trigger, context_compression_signal
import { useEffect, useRef } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { ContextCompressionSignalData, Message, ToolCall } from '@shared/contract';
import type { PlanApprovalRecord } from '@shared/contract/planApproval';
import { applyPlanApprovalToMessage } from '../../../utils/planApprovalView';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useStreamResumeStore } from '../../../stores/streamResumeStore';
import { userMessageReplacement } from '../../../utils/optimisticUserSend';
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
import {
  buildContextCompressionSignalMessage,
  parseContextCompressionSignal,
} from '../../../components/features/chat/contextCompressionSignal';
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
  normalizeStreamReconnectingPayload,
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
  /**
   * ADR-068 刀 4（B2 诚实分段）：turnId → { 续答段消息 id, 分段时的 attempt }。B2 断流后
   * host 的续答 delta 仍按原 turnId 寻址（emitAssistantMessageDelta 的 messageId=
   * currentTurnId 不变），不重定向就会 append 进定格的断点段冒充单次生成（D2 禁止）。
   * splitAtAttempt 用于重放幂等：attempt 不超过已分段水位时不二次切段。无分段时查不到，
   * 行为与改前完全一致。
   */
  segmentRedirectByTurn: Map<string, { segmentId: string; splitAtAttempt: number }>;
}

/**
 * B2 分段后的目标消息解析：显式 turnId/messageId 先过重定向表，再查消息列表。
 * 顺序不能反——断点段消息的 id 就是原 turnId，直接命中就永远轮不到重定向。
 */
function resolveStreamTargetId(
  state: ConversationStreamState,
  targetMessageId: string | null | undefined,
): string | null | undefined {
  if (!targetMessageId) return targetMessageId;
  return state.segmentRedirectByTurn.get(targetMessageId)?.segmentId ?? targetMessageId;
}

function appendAssistantStreamDelta(
  actions: ConversationStreamEventActions,
  messageId: string,
  delta: { content?: string; reasoning?: string },
): void {
  // 续答恢复即消除断流信号（B1 回到同一消息 / B2 落到续答段都在这里过）
  actions.notifyStreamResumeActivity?.(messageId);
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

    case 'plan_approval_update':
      {
        // 审批异步落定（启动确认 → approved / 启动失败 → failed）在宿主侧改写的是
        // 消息 toolCalls 元数据，聊天流不会重放消息，这里把记录合进本地副本：
        // failed 卡因此带着原因重新出现并可重试。
        const data = event.data;
        if (!data || typeof data !== 'object') break;
        const { messageId, toolCallId, approval } = data as {
          messageId?: unknown; toolCallId?: unknown; approval?: unknown;
        };
        if (typeof messageId !== 'string' || typeof toolCallId !== 'string' || !approval || typeof approval !== 'object') break;
        const target = getFreshMessages().find((message) => message.id === messageId);
        if (!target) break;
        actions.updateMessage(messageId, applyPlanApprovalToMessage(target, toolCallId, approval as PlanApprovalRecord));
      }
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
        // ADR-068 刀 4：新轮开始 = 旧轮的续接信号与分段重定向过期（终态事件之外的
        // 第二道清除）。只清别的轮——同轮 turn_start 重放时清掉自己会把已分段的
        // 续答接回断点段，拼缝。
        const priorSignal = useStreamResumeStore.getState().signal;
        if (priorSignal && priorSignal.turnId !== turnId) {
          useStreamResumeStore.getState().clear();
        }
        for (const key of [...state.segmentRedirectByTurn.keys()]) {
          if (key !== turnId) state.segmentRedirectByTurn.delete(key);
        }
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
          metadata: { correlation: { turnId } },
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
        const targetMessageId = resolveStreamTargetId(state, chunkData.turnId || state.currentTurnMessageId);
        // 序号回头 = 重连重放，整条丢；有序号时不再看内容（内容判不了重放）。
        if (!acceptDeltaSeq(state, targetMessageId, (event.data as { deltaSeq?: unknown } | undefined)?.deltaSeq)) break;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          // 无 deltaSeq 时**不按内容丢**：合法的重复正文与重放长得一样，判错的两个方向
          // 代价不对称——重复看得见、能被后续权威快照纠正；丢字是静默的，用户永远不知道
          // 少了一段（ai-review #1696 第五轮）。方向固定为宁可重复。
          const remaining = chunkData.content;
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
              const remaining = chunkData.content;
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
        const targetMessageId = resolveStreamTargetId(state, deltaData.messageId || deltaData.turnId || state.currentTurnMessageId);
        // 生产里真正带 deltaSeq 的就是这条分支（eventBatcher 只在 message_delta 上透传），
        // 序号去重必须接在这里，接漏了等于没接（ai-review #1696 第三轮）。
        const deltaSeq = (event.data as { deltaSeq?: unknown } | undefined)?.deltaSeq;
        if (!acceptDeltaSeq(state, targetMessageId, deltaSeq)) break;
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
            const remaining = deltaData.text;
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
        const targetMessageId = resolveStreamTargetId(state, snapshotData.turnId || snapshotData.messageId || state.currentTurnMessageId);
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

    case 'stream_reconnecting':
      {
        // ADR-068 刀 4（D5）：断流续接信号——同一轮回答不重置 turn（voiceCall reconnecting
        // 先例），状态行挂断流那一刻的 streaming 消息；B2 档同时把断流消息定格成独立段、
        // 续答另起一段（带一次性续接说明），后续按原 turnId 寻址的 delta 重定向到续答段，
        // 绝不 append 进断点段冒充单次生成（D2 边界）。
        const reconnectData = normalizeStreamReconnectingPayload(event.data);
        if (!reconnectData) break;
        const turnId = reconnectData.turnId || state.currentTurnMessageId;
        if (!turnId) break;
        const freshMsgs = getFreshMessages();
        // 事件的 turnId 是对账锚点（ai-review Important）：带 turnId 的断流只接受属于该轮的
        // 消息（当前 streaming 消息 id===turnId，或该轮 B2 分段注册的续答段）。当前指向别的
        // 轮 = 旧轮的迟到信号（那轮已收尾）——整条丢弃，不冒认新轮消息切段、不给死轮建段、
        // 不劫持 current 指针。兜底按事件 turnId 找消息只在重水化（current 已丢）时轮得到。
        const redirect = state.segmentRedirectByTurn.get(turnId);
        const currentId = state.currentTurnMessageId;
        const currentBelongsToEventTurn = currentId === turnId
          || (redirect ? currentId === redirect.segmentId : false);
        if (reconnectData.turnId && currentId != null && !currentBelongsToEventTurn) break;
        const draft = freshMsgs.find(m => m.id === currentId && m.role === 'assistant')
          ?? freshMsgs.find(m => m.id === turnId && m.role === 'assistant');
        if (!draft) break;
        const resumeStore = useStreamResumeStore.getState();
        // 分段只对「新断流」做（attempt 递增）；SSE 重连重放同一条信号时续答段已在，
        // 再切一段会把已恢复的轮切成孤儿——splitAtAttempt 就是防这个的。
        const needsSplit = reconnectData.segment === 'b2'
          && Boolean(draft.content?.trim())
          && (!redirect || reconnectData.attempt > redirect.splitAtAttempt);
        if (needsSplit) {
          const segmentMessage: Message = {
            id: makeId(),
            role: 'assistant',
            content: '',
            timestamp: now(),
            toolCalls: [],
            metadata: {
              // correlation.turnId 与 turn_start 建的 streaming 消息同款：续答段是 renderer
              // 侧构造、id 与 host 落库终稿不同——没有这个配对键，收尾 session/load 的
              // live-tail 合并配不上对，DB 终稿与 live 续答段会并成两条重复正文。
              correlation: { turnId },
              streamResumeNote: { attempt: reconnectData.attempt, maxReconnects: reconnectData.maxReconnects },
            },
          };
          actions.addMessage(segmentMessage);
          state.segmentRedirectByTurn.set(turnId, {
            segmentId: segmentMessage.id,
            splitAtAttempt: reconnectData.attempt,
          });
          state.currentTurnMessageId = segmentMessage.id;
          state.committedAssistantMessageIds.delete(segmentMessage.id);
          resumeStore.setSignal({
            turnId,
            messageId: draft.id,
            segmentMessageId: segmentMessage.id,
            attempt: reconnectData.attempt,
            maxReconnects: reconnectData.maxReconnects,
            signaledAt: now(),
          });
        } else {
          // B1 无缝续打不动消息；重放/空断点（无可见正文，host 侧 partial 落库本就是 no-op）
          // 只刷新信号。重放时续答段可能已在——挂回原断点段与续答段的信号关系。
          const segmentId = redirect?.segmentId;
          resumeStore.setSignal({
            turnId,
            messageId: draft.id,
            ...(segmentId ? { segmentMessageId: segmentId } : {}),
            attempt: reconnectData.attempt,
            maxReconnects: reconnectData.maxReconnects,
            signaledAt: now(),
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

    case 'context_compression_signal':
      {
        const data = event.data as Partial<ContextCompressionSignalData> | undefined;
        if (typeof data?.signalId !== 'string' || typeof data.code !== 'string' || typeof data.kind !== 'string') break;
        if (data.surface === 'health') {
          const health = useAppStore.getState().contextHealth;
          if (health) {
            useAppStore.getState().setContextHealth({
              ...health,
              compression: {
                ...(health.compression ?? { status: 'none', compressionCount: 0, totalSavedTokens: 0 }),
                lastSignal: {
                  kind: data.kind as ContextCompressionSignalData['kind'],
                  code: data.code as ContextCompressionSignalData['code'],
                  timestamp: data.timestamp ?? Date.now(),
                  ...(typeof data.cooldownUntil === 'number' ? { cooldownUntil: data.cooldownUntil } : {}),
                  ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
                },
              },
            });
          }
          break;
        }
        if (data.surface !== 'conversation') break;
        const alreadyShown = getFreshMessages().some((message) => {
          const signal = parseContextCompressionSignal(message.content);
          return signal?.signalId === data.signalId;
        });
        if (alreadyShown) break;
        actions.addMessage(buildContextCompressionSignalMessage(data as ContextCompressionSignalData));
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
          const existing = getFreshMessages().find((message) => message.id === userMessage.id);
          if (existing) {
            // 失败气泡编辑重发后 host 按同 id 回放：更新正文/附件并清 sendFailed，
            // 不能 skip，否则界面仍停在旧内容 A + 「没发出去」。
            actions.updateMessage(userMessage.id, userMessageReplacement(existing, {
              content: userMessage.content,
              attachments: userMessage.attachments,
              metadata: userMessage.metadata,
            }));
          } else {
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
        const targetMessageId = resolveStreamTargetId(state, messageData.turnId || state.currentTurnMessageId);
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
          // 续答终稿落到分段消息 = 恢复完成，消除断流信号（B1 同消息 commit 同理）
          actions.notifyStreamResumeActivity?.(targetMessage.id);

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
        const targetMessageId = resolveStreamTargetId(state, reasoningData.turnId || state.currentTurnMessageId);
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (targetMessage?.role === 'assistant') {
          const remaining = reasoningData.content;
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
  // ADR-068 刀 4：B2 分段重定向同因挂 ref（同 lastDeltaSeqByTurn 的寿命要求）
  const segmentRedirectByTurnRef = useRef<Map<string, { segmentId: string; splitAtAttempt: number }>>(new Map());

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
              segmentRedirectByTurn: segmentRedirectByTurnRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
              notifyStreamResumeActivity: (messageId) => useStreamResumeStore.getState().resolveIfActivityOn(messageId),
            },
          );
          logger.debug('turn_start - created message', { turnId: currentTurnMessageIdRef.current, sessionId: eventSessionId });
          break;

        case 'stream_chunk':
        case 'message_delta':
        case 'message_snapshot':
        case 'model_decision':
        case 'plan_approval_update':
        case 'stream_usage':
        case 'stream_reconnecting':
        case 'context_compression_signal':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.type === 'stream_reconnecting') {
            // 断流判定前先把流式缓冲落地：delta 走 accumulator（setTimeout 定时 flush 进
            // messages），断流事件同步到达时 PART1 可能还在缓冲里——不冲掉就当「空断点」
            // 处理，B2 不切段、续答 append 进断点段拼缝（D2，e2e stream-resume 抓到的
            // 真机形状；单测的 actions 直写 messages，形状与生产不一致测不出这个）。
            flushRef.current();
            flushStreamingMessages();
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
              segmentRedirectByTurn: segmentRedirectByTurnRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
              notifyStreamResumeActivity: (messageId) => useStreamResumeStore.getState().resolveIfActivityOn(messageId),
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
              segmentRedirectByTurn: segmentRedirectByTurnRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
              notifyStreamResumeActivity: (messageId) => useStreamResumeStore.getState().resolveIfActivityOn(messageId),
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
              segmentRedirectByTurn: segmentRedirectByTurnRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
              notifyStreamResumeActivity: (messageId) => useStreamResumeStore.getState().resolveIfActivityOn(messageId),
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
          // ADR-068 刀 4：轮终态——续接信号兜底消除（成功续答早在 delta 到达时消过，
          // 这里兜「预算耗尽转 error」「取消」等终路），分段重定向同轮作废。
          {
            const endedTurnId = normalizeTurnIdPayload(event.data).turnId;
            const signal = useStreamResumeStore.getState().signal;
            if (!endedTurnId || signal?.turnId === endedTurnId) {
              useStreamResumeStore.getState().clear();
            }
            if (endedTurnId) segmentRedirectByTurnRef.current.delete(endedTurnId);
          }
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
              segmentRedirectByTurn: segmentRedirectByTurnRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
              notifyStreamResumeActivity: (messageId) => useStreamResumeStore.getState().resolveIfActivityOn(messageId),
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
              segmentRedirectByTurn: segmentRedirectByTurnRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
              notifyStreamResumeActivity: (messageId) => useStreamResumeStore.getState().resolveIfActivityOn(messageId),
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
