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

import { useCallback, useRef } from 'react';
import type { Message } from '@shared/contract';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useMessageBatcher, type MessageUpdate } from './useMessageBatcher';
import { useAgentDerived } from './agent/useAgentDerived';
import { useAgentEffects } from './agent/useAgentEffects';
import { useAgentIPC } from './agent/useAgentIPC';
import { useAgentState } from './agent/useAgentState';

export { resolveDirectRouting } from './agent/useAgentIPC';

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

  const handleBatchUpdate = useCallback((updates: MessageUpdate[]) => {
    const currentMessages = useSessionStore.getState().messages;
    for (const update of updates) {
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
    enqueuePermissionRequest,
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
    isProcessing,
    setIsInterrupting,
    setIsProcessing,
    setSessionProcessing,
  });

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
  };
};
