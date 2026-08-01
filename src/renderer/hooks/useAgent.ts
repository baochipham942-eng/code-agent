// ============================================================================
// useAgent - Agent Communication Hook
// ============================================================================
//
// 消息流架构设计（基于 Vercel AI SDK / LangGraph 最佳实践）:
//
// 1. Turn-Based Message Model:
//    - 每轮 Agent Loop 迭代对应一条 assistant 消息
//    - 后端发送 turn_start 事件创建新消息，前端不自行创建
//    - 使用 turnId 关联同一轮的所有事件
//
// 2. Event Flow:
//    turn_start -> stream_chunk* -> stream_tool_call_start? -> tool_call_end? -> turn_end
//    |                                                                              |
//    v                                                                              v
//    创建新 assistant 消息                                          标记消息完成，可能继续下一轮
//
// 3. Message States:
//    - streaming: 正在接收流式内容
//    - tool_executing: 工具正在执行
//    - completed: 本轮完成
//
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import type { Message } from '@shared/contract';
import type { QueuedInputSettledEvent } from '@shared/contract/queuedInput';
import { submitSteerEnvelope } from '../components/features/chat/chatViewSteer';
import { QueuedInputSchemas } from '@shared/ipc/schemas';
import ipcService from '../services/ipcService';
import { generateMessageId } from '@shared/utils/id';
import { useAppStore } from '../stores/appStore';
import { useRunControlStore } from '../stores/runControlStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useStreamingMessageAccumulatorStore, type StreamingMessageDelta } from '../stores/streamingMessageAccumulatorStore';
import { typedInvokeDomain } from '../services/typedInvoke';
import { createLogger } from '../utils/logger';
import { toast } from './useToast';
import { useI18n } from './useI18n';
import { useMessageBatcher, type MessageUpdate } from './useMessageBatcher';
import { useAgentDerived } from './agent/useAgentDerived';
import { useAgentEffects } from './agent/useAgentEffects';
import {
  getAgentSendFailureMessage,
  getRuntimeInputMode,
  isRuntimeBusyStatus,
  useAgentIPC,
  type QueuedRuntimeInput,
} from './agent/useAgentIPC';
import { useAgentState } from './agent/useAgentState';
import { applyToolCallArgumentDelta } from '../utils/toolCallStreaming';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';
import { IPC_CHANNELS } from '@shared/ipc';

export { resolveDirectRouting } from './agent/useAgentIPC';

// 流式增量从 accumulator 推进 React state 的节流间隔。
// 越小 → 文字到达越连续（更平滑）；markdown 重渲染另有 96ms 节流兜底，
// 故这里压到 150ms 主要让纯文本流不再「半秒蹦一坨」，又不至于过度重渲染。
const STREAMING_MESSAGE_FLUSH_INTERVAL_MS = 150;
const logger = createLogger('useAgent');

/** 排队消息「现在不能按原路发」的三种情形：前两种硬拒，busy 走立即转向。 */
type QueuedSendBlock = {
  /** busy = 正在回复中，可立即转向；其余一律硬拒并出声。 */
  kind: 'inFlight' | 'cancelling' | 'notSteerable' | 'busy';
  message: string;
};

const QUEUED_RESEND_RETRY_DELAY_MS = 500;

export function requeueAtFront(
  queue: QueuedRuntimeInput[],
  item: QueuedRuntimeInput,
): QueuedRuntimeInput[] {
  return [item, ...queue.filter((existing) => existing.id !== item.id)];
}

function buildStreamingDeltaChanges(
  message: Message,
  entry: StreamingMessageDelta,
): Partial<Message> | null {
  const changes: Partial<Message> = {};
  if (entry.contentDelta) {
    changes.content = (message.content || '') + entry.contentDelta;
  }
  if (entry.reasoningDelta) {
    changes.reasoning = (message.reasoning || '') + entry.reasoningDelta;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

export const useAgent = () => {
  const {
    setIsProcessing,
    setSessionProcessing,
    isProcessing,
    setPendingPermissionRequest,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    enqueuePermissionRequest,
    shiftQueuedPermissionRequest,
    setSessionTaskProgress,
    setSessionTaskComplete,
    sessionTaskProgress,
    sessionTaskComplete,
  } = useAppStore();

  const {
    messages,
    addMessage,
    updateMessage,
    setSessionTasks,
    setTodos,
    currentSessionId,
  } = useSessionStore();
  const currentSessionTaskStatus = useTaskStore((state) => (
    currentSessionId ? state.sessionStates[currentSessionId]?.status : undefined
  ));
  const { t } = useI18n();

  const {
    currentTurnMessageIdRef,
    lastEventAtRef,
    activeToolProgress,
    setActiveToolProgress,
    toolTimeoutWarning,
    setToolTimeoutWarning,
    researchDetected,
    setResearchDetected,
    isInterrupting,
    setIsInterrupting,
  } = useAgentState();

  const streamingFlushTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const queuedRuntimeInputsRef = useRef<QueuedRuntimeInput[]>([]);
  const queuedRuntimeInputSendInFlightRef = useRef<Set<string>>(new Set());
  const queuedRuntimeInputHydrationSuppressedIdsRef = useRef<Set<string>>(new Set());
  const queuedRuntimeInputHydrationVersionRef = useRef(0);
  const queuedRuntimeInputRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [queuedRuntimeInputs, setQueuedRuntimeInputsSnapshot] = useState<QueuedRuntimeInput[]>([]);
  const previousQueuedRuntimeInputBusyStateRef = useRef({
    sessionId: currentSessionId,
    isBusy: isRuntimeBusyStatus(currentSessionTaskStatus),
  });

  /**
   * 排队消息「现在能不能发」的唯一判据，与 useAgentIPC.sendMessage 的排队/取消判定同源同序
   * （先 cancelling 后 busy）。返回 null = 可发；返回字符串 = 不可发的人话原因。
   */
  const getQueuedSendBlockReason = useCallback((sessionId: string, id: string): QueuedSendBlock | null => {
    if (queuedRuntimeInputSendInFlightRef.current.has(id)) {
      return { kind: 'inFlight', message: t.chatInput.queuedSendBlockedInFlight };
    }
    const status = useTaskStore.getState().sessionStates[sessionId]?.status;
    if (status === 'cancelling') {
      return { kind: 'cancelling', message: t.chatInput.queuedSendBlockedCancelling };
    }
    // 「正在回复中」才可转向（拍板 A 的适用范围就是这一档）。
    // paused / queued 同属 isRuntimeBusyStatus 但**不是**回复中：对它们发 interrupt
    // 多半只会被重新排队，那就又回到本文件死磕的那个老 bug——点了没反应、
    // 且条目已被 markSending 变成宿主不恢复的 sending 孤儿。所以它们照旧硬拒 + 出声。
    if (status === 'running' || useAppStore.getState().isSessionProcessing(sessionId)) {
      return { kind: 'busy', message: t.chatInput.queuedSendBlockedBusy };
    }
    if (isRuntimeBusyStatus(status)) {
      return { kind: 'notSteerable', message: t.chatInput.queuedSendBlockedBusy };
    }
    return null;
  }, [t]);

  const setQueuedRuntimeInputs = useCallback((
    updater: QueuedRuntimeInput[] | ((current: QueuedRuntimeInput[]) => QueuedRuntimeInput[]),
  ) => {
    const next = typeof updater === 'function'
      ? updater(queuedRuntimeInputsRef.current)
      : updater;
    queuedRuntimeInputsRef.current = next;
    setQueuedRuntimeInputsSnapshot(next);
  }, []);

  const enqueueRuntimeInput = useCallback((input: QueuedRuntimeInput) => {
    setQueuedRuntimeInputs((current) => [
      ...current.filter((item) => item.id !== input.id),
      input,
    ]);
  }, [setQueuedRuntimeInputs]);

  const cancelQueuedRuntimeInput = useCallback(async (id: string) => {
    const queued = queuedRuntimeInputsRef.current.find((item) => item.id === id);
    if (!queued) return;

    if (queued.sendFailed) {
      setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== id));
      return;
    }

    try {
      const response = await typedInvokeDomain(QueuedInputSchemas.RETRACT, {
        action: 'retract',
        payload: { id },
      });
      if (!response.success) {
        toast.error(`撤回排队消息失败：${response.error.message}`);
        return;
      }
      if (!response.data.retracted) {
        toast.info('这条消息已经开始发送，无法撤回。');
        return;
      }
      setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      logger.error('Failed to retract queued runtime input', error, { id });
      toast.error(`撤回排队消息失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setQueuedRuntimeInputs]);

  const hydrateQueuedRuntimeInputs = useCallback(async (sessionId: string) => {
    const hydrationVersion = queuedRuntimeInputHydrationVersionRef.current + 1;
    queuedRuntimeInputHydrationVersionRef.current = hydrationVersion;
    const idsAtQueryStart = new Set(
      queuedRuntimeInputsRef.current
        .filter((input) => input.sessionId === sessionId && !input.sendFailed)
        .map((input) => input.id),
    );

    try {
      const response = await typedInvokeDomain(QueuedInputSchemas.LIST, {
        action: 'list',
        payload: { sessionId, status: 'queued' },
      });
      if (
        hydrationVersion !== queuedRuntimeInputHydrationVersionRef.current
        || useSessionStore.getState().currentSessionId !== sessionId
      ) {
        return;
      }
      if (!response.success) {
        throw new Error(response.error.message);
      }

      const hydrated = response.data
        .filter((input) => !queuedRuntimeInputHydrationSuppressedIdsRef.current.has(input.id))
        .map<QueuedRuntimeInput>((input) => ({
          id: input.id,
          sessionId: input.sessionId,
          envelope: input.envelope,
          content: input.envelope.content,
          mode: getRuntimeInputMode(input.envelope.context),
          attachmentsCount: input.envelope.attachments?.length || 0,
          createdAt: input.createdAt,
          retryCount: input.retryCount,
        }));
      const hydratedIds = new Set(hydrated.map((input) => input.id));
      setQueuedRuntimeInputs((current) => [
        ...hydrated,
        ...current.filter((input) => (
          input.sessionId === sessionId
          && !hydratedIds.has(input.id)
          && (input.sendFailed || !idsAtQueryStart.has(input.id))
        )),
      ]);
    } catch (error) {
      if (
        hydrationVersion === queuedRuntimeInputHydrationVersionRef.current
        && useSessionStore.getState().currentSessionId === sessionId
      ) {
        logger.error('Failed to hydrate queued runtime inputs', error, { sessionId });
      }
    }
  }, [setQueuedRuntimeInputs]);

  useEffect(() => {
    setQueuedRuntimeInputs([]);
    if (!currentSessionId) {
      queuedRuntimeInputHydrationVersionRef.current += 1;
      return;
    }

    void hydrateQueuedRuntimeInputs(currentSessionId);
  }, [currentSessionId, hydrateQueuedRuntimeInputs, setQueuedRuntimeInputs]);

  // 宿主自动抽干排队消息后，前端本地卡片得跟着消失。
  // 「立即发送」那条路由前端自己走完生命周期会清卡；宿主抽干那条路前端完全不知情，
  // 不听这条广播的话卡片永远留着，点撤回还会被如实告知「已经开始发送」——
  // 用户看到的就是「没自动发出去、还删不掉」（2026-07-27 产品负责人实测）。
  useEffect(() => {
    const unsubscribe = ipcService.on(
      IPC_CHANNELS.QUEUED_INPUT_SETTLED,
      (settled: QueuedInputSettledEvent) => {
        if (!settled?.id) return;
        queuedRuntimeInputHydrationSuppressedIdsRef.current.delete(settled.id);
        setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== settled.id));
      },
    );
    return unsubscribe;
  }, [setQueuedRuntimeInputs]);

  useEffect(() => {
    const isBusy = isRuntimeBusyStatus(currentSessionTaskStatus);
    const previous = previousQueuedRuntimeInputBusyStateRef.current;
    previousQueuedRuntimeInputBusyStateRef.current = {
      sessionId: currentSessionId,
      isBusy,
    };

    if (
      !currentSessionId
      || !isBusy
      || previous.sessionId !== currentSessionId
      || previous.isBusy
    ) {
      return;
    }

    void hydrateQueuedRuntimeInputs(currentSessionId);
  }, [currentSessionId, currentSessionTaskStatus, hydrateQueuedRuntimeInputs]);

  const clearStreamingFlushTimer = useCallback((messageId: string) => {
    const timer = streamingFlushTimersRef.current.get(messageId);
    if (timer) {
      clearTimeout(timer);
      streamingFlushTimersRef.current.delete(messageId);
    }
  }, []);

  const flushStreamingMessage = useCallback((messageId: string) => {
    clearStreamingFlushTimer(messageId);
    const entry = useStreamingMessageAccumulatorStore.getState().entries[messageId];
    if (!entry) return;

    const targetMessage = useSessionStore.getState().messages.find(m => m.id === messageId);
    if (targetMessage?.role !== 'assistant') {
      useStreamingMessageAccumulatorStore.getState().clear(messageId);
      return;
    }

    const changes = buildStreamingDeltaChanges(targetMessage, entry);
    recordStreamingPerformanceCounter('stream.accumulator.flush');
    recordStreamingPerformanceCounter(
      'stream.accumulator.flush_chars',
      entry.contentDelta.length + entry.reasoningDelta.length,
    );
    unstable_batchedUpdates(() => {
      useStreamingMessageAccumulatorStore.getState().clear(messageId);
      if (changes) {
        updateMessage(messageId, changes);
      }
    });
  }, [clearStreamingFlushTimer, updateMessage]);

  const flushStreamingMessages = useCallback(() => {
    for (const timer of streamingFlushTimersRef.current.values()) {
      clearTimeout(timer);
    }
    streamingFlushTimersRef.current.clear();

    const entries = useStreamingMessageAccumulatorStore.getState().entries;
    if (Object.keys(entries).length === 0) return;

    const updates: Array<{ messageId: string; changes: Partial<Message> }> = [];
    let flushChars = 0;
    for (const [messageId, entry] of Object.entries(entries)) {
      const targetMessage = useSessionStore.getState().messages.find(m => m.id === messageId);
      if (targetMessage?.role !== 'assistant') continue;

      const changes = buildStreamingDeltaChanges(targetMessage, entry);
      if (changes) {
        flushChars += entry.contentDelta.length + entry.reasoningDelta.length;
        updates.push({ messageId, changes });
      }
    }
    recordStreamingPerformanceCounter('stream.accumulator.flush', updates.length);
    recordStreamingPerformanceCounter('stream.accumulator.flush_chars', flushChars);

    unstable_batchedUpdates(() => {
      useStreamingMessageAccumulatorStore.getState().consumeAll();
      for (const update of updates) {
        updateMessage(update.messageId, update.changes);
      }
    });
  }, [updateMessage]);

  const appendStreamingMessageDelta = useCallback((messageId: string, delta: { content?: string; reasoning?: string }) => {
    useStreamingMessageAccumulatorStore.getState().appendDelta(messageId, delta);
    if (streamingFlushTimersRef.current.has(messageId)) {
      return;
    }

    const timer = setTimeout(() => {
      flushStreamingMessage(messageId);
    }, STREAMING_MESSAGE_FLUSH_INTERVAL_MS);
    streamingFlushTimersRef.current.set(messageId, timer);
  }, [flushStreamingMessage]);

  useEffect(() => {
    return () => {
      flushStreamingMessages();
    };
  }, [flushStreamingMessages]);

  useEffect(() => {
    return () => {
      for (const timer of queuedRuntimeInputRetryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      queuedRuntimeInputRetryTimersRef.current.clear();
    };
  }, []);

  const handleBatchUpdate = useCallback((updates: MessageUpdate[]) => {
    for (const update of updates) {
      const currentMessages = useSessionStore.getState().messages;
      if (update.type === 'append' && (update.content || update.reasoning)) {
        const targetMessage = currentMessages.find(m => m.id === update.messageId);
        if (targetMessage?.role === 'assistant') {
          const changes: Partial<Message> = {};
          if (update.content) {
            changes.content = (targetMessage.content || '') + update.content;
          }
          if (update.reasoning) {
            changes.reasoning = (targetMessage.reasoning || '') + update.reasoning;
          }
          updateMessage(update.messageId, changes);
        }
      } else if (update.type === 'tool_call_delta') {
        const targetMessage = currentMessages.find(m => m.id === update.messageId);
        if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
          updateMessage(update.messageId, {
            toolCalls: applyToolCallArgumentDelta(targetMessage.toolCalls, update),
          });
        }
      }
    }
  }, [updateMessage]);

  const { queueUpdate, flush } = useMessageBatcher(handleBatchUpdate, {
    batchInterval: 50,
    maxBatchSize: 10,
  });

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const { taskProgress, lastTaskComplete } = useAgentDerived({
    currentSessionId,
    sessionTaskProgress,
    sessionTaskComplete,
  });

  useAgentEffects({
    addMessage,
    currentSessionId,
    currentTurnMessageIdRef,
    appendStreamingMessageDelta,
    enqueuePermissionRequest,
    flushStreamingMessages,
    flushRef,
    lastEventAtRef,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queueUpdate,
    setActiveToolProgress,
    setIsInterrupting,
    setIsProcessing,
    setPendingPermissionRequest,
    setResearchDetected,
    setSessionTaskComplete,
    setSessionTaskProgress,
    setSessionTasks,
    setTodos,
    setToolTimeoutWarning,
    shiftQueuedPermissionRequest,
    updateMessage,
  });

  const { sendMessage, cancel } = useAgentIPC({
    addMessage,
    currentSessionId,
    currentTurnMessageIdRef,
    enqueueRuntimeInput,
    isProcessing,
    setIsProcessing,
    setSessionProcessing,
  });

  /**
   * 模型回复中点排队卡片的「发送」= 立即转向：打断当轮，把这条插进去。
   *
   * 全程严守本文件的老教训：一旦 markSending 成功，这条就离开了 'queued' 态，
   * 而宿主不恢复 sending 孤儿行——所以任何一条没转向成功的路径都必须显式
   * reportSendOutcome 把它退回队列或标失败，绝不能就这么扔着，否则用户看到的
   * 就是「发不出去又删不掉」。
   */
  const steerQueuedRuntimeInput = useCallback(async (queued: QueuedRuntimeInput) => {
    const id = queued.id;
    queuedRuntimeInputSendInFlightRef.current.add(id);
    try {
      const markResponse = await typedInvokeDomain(QueuedInputSchemas.MARK_SENDING, {
        action: 'markSending',
        payload: { id },
      });
      if (!markResponse.success) {
        logger.error(
          'Failed to mark queued runtime input as sending before steer',
          new Error(markResponse.error.message),
          { id },
        );
        return;
      }
      if (!markResponse.data.marked) return;

      queuedRuntimeInputHydrationSuppressedIdsRef.current.add(id);
      setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== id));

      const outcome = await submitSteerEnvelope(
        queued.envelope,
        queued.sessionId,
        async () => {},
      );

      if (outcome?.outcome === 'steered') {
        const successResponse = await typedInvokeDomain(QueuedInputSchemas.REPORT_SEND_OUTCOME, {
          action: 'reportSendOutcome',
          payload: { id, outcome: 'success' },
        });
        queuedRuntimeInputHydrationSuppressedIdsRef.current.delete(id);
        if (!successResponse.success) {
          logger.error(
            'Failed to report steered queued runtime input success',
            new Error(successResponse.error.message),
            { id },
          );
        }
        return;
      }

      // 没转向成功（宿主又把它排回去了，或 interrupt 抛错）：退回队列，别留 sending 孤儿。
      const failureResponse = await typedInvokeDomain(QueuedInputSchemas.REPORT_SEND_OUTCOME, {
        action: 'reportSendOutcome',
        payload: { id, outcome: 'failure' },
      });
      queuedRuntimeInputHydrationSuppressedIdsRef.current.delete(id);
      if (!failureResponse.success) {
        logger.error(
          'Failed to report steered queued runtime input failure',
          new Error(failureResponse.error.message),
          { id },
        );
        return;
      }
      const settled = { ...queued, retryCount: failureResponse.data.retryCount };
      setQueuedRuntimeInputs((current) => requeueAtFront(
        current,
        failureResponse.data.status === 'failed' ? { ...settled, sendFailed: true } : settled,
      ));
      // 退回队列也要出声，否则又是一个「点了没反应」。
      toast.info(t.chatInput.queuedSendBlockedBusy);
    } catch (error) {
      logger.error('Failed to steer queued runtime input', error, { id });
    } finally {
      queuedRuntimeInputSendInFlightRef.current.delete(id);
    }
  }, [setQueuedRuntimeInputs, t]);

  const sendQueuedRuntimeInput = useCallback(async (id: string) => {
    const queued = queuedRuntimeInputsRef.current.find((item) => item.id === id);
    if (!queued) return;

    // 「能不能发」必须和 sendMessage 里「发出去会不会被重新排队」用同一套判据，
    // 否则就是本文件历史上那个 bug：ChatView 的 effectiveIsProcessing 不含 'paused'，
    // 按钮照显；sendMessage 的 isRuntimeBusyStatus 含 'paused'，点下去被重新排队——
    // 而此时原条目已被 markSending 置成 'sending'，宿主又不恢复 sending 孤儿行，消息就没了。
    // 判定放在 markSending 之前，任何一条不可发都出声说明，不静默 return。
    const blockedReason = getQueuedSendBlockReason(queued.sessionId, id);
    if (blockedReason && blockedReason.kind !== 'busy') {
      toast.info(blockedReason.message);
      return;
    }
    if (blockedReason?.kind === 'busy') {
      // 产品负责人 2026-07-27 拍板 A：模型回复中点「发送」不再只弹一句「等它跑完」，
      // 直接立即转向（打断当轮把这条插进去），语义与 composer 的 ⌥↵ 一致。
      await steerQueuedRuntimeInput(queued);
      return;
    }

    queuedRuntimeInputSendInFlightRef.current.add(id);
    try {
      const markResponse = await typedInvokeDomain(QueuedInputSchemas.MARK_SENDING, {
        action: 'markSending',
        payload: { id },
      });
      if (!markResponse.success) {
        logger.error(
          'Failed to mark queued runtime input as sending',
          new Error(markResponse.error.message),
          { id },
        );
        return;
      }
      if (!markResponse.data.marked) return;

      queuedRuntimeInputHydrationSuppressedIdsRef.current.add(id);
      setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== id));

      try {
        await sendMessage(queued.envelope, { silentFailure: true });
      } catch (sendError) {
        const failureResponse = await typedInvokeDomain(QueuedInputSchemas.REPORT_SEND_OUTCOME, {
          action: 'reportSendOutcome',
          payload: { id, outcome: 'failure' },
        });
        if (!failureResponse.success) {
          logger.error(
            'Failed to report queued runtime input send failure',
            new Error(failureResponse.error.message),
            { id },
          );
          return;
        }

        const settled = {
          ...queued,
          retryCount: failureResponse.data.retryCount,
        };
        if (failureResponse.data.status === 'queued') {
          const timer = setTimeout(() => {
            queuedRuntimeInputRetryTimersRef.current.delete(id);
            queuedRuntimeInputHydrationSuppressedIdsRef.current.delete(id);
            setQueuedRuntimeInputs((current) => requeueAtFront(current, settled));
          }, QUEUED_RESEND_RETRY_DELAY_MS);
          queuedRuntimeInputRetryTimersRef.current.set(id, timer);
          return;
        }

        if (failureResponse.data.status === 'failed') {
          queuedRuntimeInputHydrationSuppressedIdsRef.current.delete(id);
          const failed = { ...settled, sendFailed: true };
          addMessage({
            id: generateMessageId(),
            role: 'assistant',
            content: getAgentSendFailureMessage(sendError),
            timestamp: Date.now(),
          });
          setQueuedRuntimeInputs((current) => requeueAtFront(current, failed));
        }
        return;
      }

      const successResponse = await typedInvokeDomain(QueuedInputSchemas.REPORT_SEND_OUTCOME, {
        action: 'reportSendOutcome',
        payload: { id, outcome: 'success' },
      });
      queuedRuntimeInputHydrationSuppressedIdsRef.current.delete(id);
      if (!successResponse.success) {
        logger.error(
          'Failed to report queued runtime input send success',
          new Error(successResponse.error.message),
          { id },
        );
      }
    } catch (error) {
      logger.error('Failed to drain queued runtime input', error, { id });
    } finally {
      queuedRuntimeInputSendInFlightRef.current.delete(id);
    }
  }, [addMessage, getQueuedSendBlockReason, sendMessage, setQueuedRuntimeInputs, steerQueuedRuntimeInput]);

  const dismissResearchDetected = useCallback(() => {
    setResearchDetected(null);
  }, [setResearchDetected]);

  // 当前会话可见的排队项——ChatInput 的排队卡和右栏 Overview 队列必须是同一份，
  // 否则两处对「还有几条在排队」各说各话。
  const visibleQueuedRuntimeInputs = useMemo(() => (
    currentSessionId
      ? queuedRuntimeInputs.filter((item) => item.sessionId === currentSessionId)
      : []
  ), [currentSessionId, queuedRuntimeInputs]);

  // 投影给右栏 Overview（T1）。队列在这里推是因为本 hook 是唯一写入方；
  // 动作直接把既有回调交出去，Overview 侧不重新实现任何 IPC 链路。
  useEffect(() => {
    useRunControlStore.getState().publishQueue(
      visibleQueuedRuntimeInputs.map((item) => ({
        id: item.id,
        content: item.content,
        attachmentsCount: item.attachmentsCount,
        sendFailed: item.sendFailed,
      })),
    );
  }, [visibleQueuedRuntimeInputs]);

  useEffect(() => {
    const store = useRunControlStore.getState();
    store.publishActions({
      interrupt: cancel,
      retractQueued: cancelQueuedRuntimeInput,
      sendQueuedNow: sendQueuedRuntimeInput,
    });
    // 聊天运行时卸载后动作就失效了，留着等于给 Overview 一批点了没反应的按钮。
    return () => {
      useRunControlStore.getState().publishActions(null);
      useRunControlStore.getState().publishQueue([]);
    };
  }, [cancel, cancelQueuedRuntimeInput, sendQueuedRuntimeInput]);

  return {
    messages,
    isProcessing,
    sendMessage,
    cancel,
    // 长时任务进度追踪
    taskProgress,
    lastTaskComplete,
    // 工具执行进度 & 超时警告
    activeToolProgress,
    toolTimeoutWarning,
    // 语义研究检测
    researchDetected,
    dismissResearchDetected,
    // 中断状态（Claude Code 风格）
    isInterrupting,
    queuedRuntimeInputs: visibleQueuedRuntimeInputs,
    hydrateQueuedRuntimeInputs,
    cancelQueuedRuntimeInput,
    sendQueuedRuntimeInput,
  };
};
