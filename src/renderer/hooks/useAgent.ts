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

import { useCallback, useEffect, useRef, useState } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import type { Message } from '@shared/contract';
import { QueuedInputSchemas } from '@shared/ipc/schemas';
import { generateMessageId } from '@shared/utils/id';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useStreamingMessageAccumulatorStore, type StreamingMessageDelta } from '../stores/streamingMessageAccumulatorStore';
import { typedInvokeDomain } from '../services/typedInvoke';
import { createLogger } from '../utils/logger';
import { toast } from './useToast';
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

export { resolveDirectRouting } from './agent/useAgentIPC';

// 流式增量从 accumulator 推进 React state 的节流间隔。
// 越小 → 文字到达越连续（更平滑）；markdown 重渲染另有 96ms 节流兜底，
// 故这里压到 150ms 主要让纯文本流不再「半秒蹦一坨」，又不至于过度重渲染。
const STREAMING_MESSAGE_FLUSH_INTERVAL_MS = 150;
const logger = createLogger('useAgent');

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
  const queuedRuntimeInputRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [queuedRuntimeInputs, setQueuedRuntimeInputsSnapshot] = useState<QueuedRuntimeInput[]>([]);

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

  useEffect(() => {
    setQueuedRuntimeInputs([]);
    if (!currentSessionId) return;

    const sessionId = currentSessionId;
    let cancelled = false;

    void (async () => {
      try {
        const response = await typedInvokeDomain(QueuedInputSchemas.LIST, {
          action: 'list',
          payload: { sessionId, status: 'queued' },
        });
        if (cancelled || useSessionStore.getState().currentSessionId !== sessionId) return;
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
            input.sessionId === sessionId && !hydratedIds.has(input.id)
          )),
        ]);
      } catch (error) {
        if (!cancelled) {
          logger.error('Failed to hydrate queued runtime inputs', error, { sessionId });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, setQueuedRuntimeInputs]);

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

  const sendQueuedRuntimeInput = useCallback(async (id: string) => {
    const queued = queuedRuntimeInputsRef.current.find((item) => item.id === id);
    if (!queued || queuedRuntimeInputSendInFlightRef.current.has(id)) return;

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
  }, [addMessage, sendMessage, setQueuedRuntimeInputs]);

  useEffect(() => {
    if (
      isProcessing
      || !currentSessionId
      || isRuntimeBusyStatus(currentSessionTaskStatus)
      || currentSessionTaskStatus === 'cancelling'
    ) {
      return;
    }
    const nextQueued = queuedRuntimeInputs.find((item) => (
      item.sessionId === currentSessionId && !item.sendFailed
    ));
    if (!nextQueued) return;
    void sendQueuedRuntimeInput(nextQueued.id);
  }, [currentSessionId, currentSessionTaskStatus, isProcessing, queuedRuntimeInputs, sendQueuedRuntimeInput]);

  const dismissResearchDetected = useCallback(() => {
    setResearchDetected(null);
  }, [setResearchDetected]);

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
    queuedRuntimeInputs: currentSessionId
      ? queuedRuntimeInputs.filter((item) => item.sessionId === currentSessionId)
      : [],
    cancelQueuedRuntimeInput,
    sendQueuedRuntimeInput,
  };
};
