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
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useStreamingMessageAccumulatorStore, type StreamingMessageDelta } from '../stores/streamingMessageAccumulatorStore';
import { useMessageBatcher, type MessageUpdate } from './useMessageBatcher';
import { useAgentDerived } from './agent/useAgentDerived';
import { useAgentEffects } from './agent/useAgentEffects';
import { isRuntimeBusyStatus, useAgentIPC, type QueuedRuntimeInput } from './agent/useAgentIPC';
import { useAgentState } from './agent/useAgentState';
import { applyToolCallArgumentDelta } from '../utils/toolCallStreaming';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';

export { resolveDirectRouting } from './agent/useAgentIPC';

// 流式增量从 accumulator 推进 React state 的节流间隔。
// 越小 → 文字到达越连续（更平滑）；markdown 重渲染另有 96ms 节流兜底，
// 故这里压到 150ms 主要让纯文本流不再「半秒蹦一坨」，又不至于过度重渲染。
const STREAMING_MESSAGE_FLUSH_INTERVAL_MS = 150;

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

  const cancelQueuedRuntimeInput = useCallback((id: string) => {
    setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== id));
  }, [setQueuedRuntimeInputs]);

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
    setQueuedRuntimeInputs((current) => current.filter((item) => item.id !== id));
    try {
      await sendMessage(queued.envelope);
    } finally {
      queuedRuntimeInputSendInFlightRef.current.delete(id);
    }
  }, [sendMessage, setQueuedRuntimeInputs]);

  useEffect(() => {
    if (
      isProcessing
      || !currentSessionId
      || isRuntimeBusyStatus(currentSessionTaskStatus)
      || currentSessionTaskStatus === 'cancelling'
    ) {
      return;
    }
    const nextQueued = queuedRuntimeInputs.find((item) => item.sessionId === currentSessionId);
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
