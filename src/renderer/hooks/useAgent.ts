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
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { generateMessageId } from '@shared/utils/id';
import type { Message, MessageAttachment, ToolCall, ToolResult, PermissionRequest, TaskProgressData, TaskCompleteData, ResearchDetectedData } from '@shared/types';
import { createLogger } from '../utils/logger';
import { useMessageBatcher, type MessageUpdate } from './useMessageBatcher';

const logger = createLogger('useAgent');

export const useAgent = () => {
  const {
    setIsProcessing,
    setSessionProcessing,
    isProcessing,
    currentGeneration,
    setPendingPermissionRequest,
  } = useAppStore();

  const {
    messages,
    addMessage,
    updateMessage,
    setTodos,
    currentSessionId,
  } = useSessionStore();

  // Use refs to avoid stale closure issues
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Track current turn's message ID for proper event routing
  const currentTurnMessageIdRef = useRef<string | null>(null);

  // 追踪任务开始时的会话 ID（用于跨会话未读通知）
  const taskSessionIdRef = useRef<string | null>(null);

  // 任务进度状态（长时任务反馈）
  const [taskProgress, setTaskProgress] = useState<TaskProgressData | null>(null);
  const [lastTaskComplete, setLastTaskComplete] = useState<TaskCompleteData | null>(null);

  // 语义研究检测状态
  const [researchDetected, setResearchDetected] = useState<ResearchDetectedData | null>(null);

  // Message batcher for reducing re-renders during streaming
  const handleBatchUpdate = useCallback((updates: MessageUpdate[]) => {
    const currentMessages = messagesRef.current;
    for (const update of updates) {
      if (update.type === 'append' && update.content) {
        const targetMessage = currentMessages.find(m => m.id === update.messageId);
        if (targetMessage?.role === 'assistant') {
          updateMessage(update.messageId, {
            content: (targetMessage.content || '') + update.content,
          });
        }
      }
    }
  }, [updateMessage]);

  const { queueUpdate, flush } = useMessageBatcher(handleBatchUpdate, {
    batchInterval: 50,
    maxBatchSize: 10,
  });

  // Keep flush in a ref to avoid stale closures in event listener
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Listen for agent events from the main process
  // Only register once, use refs to access latest state
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
      'agent:event',
      (event: { type: string; data: any; sessionId?: string }) => {
        // 只对非流式事件打印日志，避免控制台刷屏
        const silentEvents = ['stream_chunk', 'stream_tool_call_delta'];
        if (!silentEvents.includes(event.type)) {
          logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
        }

        // 会话隔离：只处理属于当前会话的事件
        // 但完成类事件需要跨会话处理（清除处理状态）
        const currentSessionId = useSessionStore.getState().currentSessionId;
        const isCompletionEvent = ['agent_complete', 'error'].includes(event.type);

        if (event.sessionId && event.sessionId !== currentSessionId && !isCompletionEvent) {
          // 事件属于其他会话，且不是完成类事件，忽略
          return;
        }

        // 辅助函数：清除会话处理状态
        const clearSessionProcessing = () => {
          const sessionId = event.sessionId || currentSessionId;
          if (sessionId) {
            useAppStore.getState().setSessionProcessing(sessionId, false);
          } else {
            setIsProcessing(false);
          }
        };

        // Always get the latest messages from ref
        const currentMessages = messagesRef.current;

        switch (event.type) {
          // ================================================================
          // Turn-based message handling (行业最佳实践)
          // ================================================================

          case 'turn_start':
            // 新一轮 Agent Loop 开始 - 创建新的 assistant 消息
            // 这是后端驱动的消息创建，确保每轮对应一条消息
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
              // 记录任务开始时的会话 ID
              taskSessionIdRef.current = useSessionStore.getState().currentSessionId;
              logger.debug('turn_start - created message', { turnId, sessionId: taskSessionIdRef.current });
            }
            break;

          case 'stream_chunk':
            // 流式文本内容 - 追加到当前 turn 的消息（使用批处理优化）
            if (event.data?.content) {
              // 优先使用 turnId 定位消息，fallback 到最后一条 assistant 消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              if (targetMessage?.role === 'assistant') {
                // 使用批处理更新，减少重渲染频率
                queueUpdate({
                  type: 'append',
                  messageId: targetMessage.id,
                  content: event.data.content,
                });
              } else {
                // Fallback: 如果没有找到目标消息，创建一个新的（兼容旧事件格式）
                const lastMessage = currentMessages[currentMessages.length - 1];
                if (lastMessage?.role === 'assistant') {
                  // 检查是否需要创建新消息（旧逻辑兼容）
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
                    // 使用批处理更新
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
            // 完整消息事件（非流式或流式结束）
            // 主要用于更新工具调用信息
            if (event.data) {
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              if (targetMessage?.role === 'assistant') {
                // 保留已有的流式内容
                const existingContent = targetMessage.content || '';
                const newContent = event.data.content || '';

                updateMessage(targetMessage.id, {
                  content: existingContent.length >= newContent.length ? existingContent : newContent,
                  toolCalls: event.data.toolCalls || targetMessage.toolCalls,
                });
              }
              // 纯文本消息（无工具调用）表示本轮结束
              if (!event.data.toolCalls || event.data.toolCalls.length === 0) {
                clearSessionProcessing();
              }
            }
            break;

          case 'turn_end':
            // 本轮 Agent Loop 结束
            // 刷新所有待处理的流式更新，确保内容完整显示
            flushRef.current();
            logger.debug('turn_end', { turnId: event.data?.turnId });
            break;

          case 'stream_tool_call_start':
            // 流式工具调用开始 - 立即显示工具调用（带 streaming 标记）
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              logger.debug('stream_tool_call_start', { data: event.data, targetMessageId });
              if (targetMessage?.role === 'assistant') {
                const newToolCall: ToolCall = {
                  id: event.data.id || `pending_${event.data.index}`,
                  name: event.data.name || '',
                  arguments: {},
                  _streaming: true, // 标记为流式中
                  _argumentsRaw: '', // 累积原始参数字符串
                };
                updateMessage(targetMessage.id, {
                  toolCalls: [...(targetMessage.toolCalls || []), newToolCall],
                });
              }
            }
            break;

          case 'stream_tool_call_delta':
            // 流式工具调用增量更新
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
                const index = event.data.index ?? 0;
                const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, i: number) => {
                  // 简单地按索引匹配
                  if (i === index) {
                    const newTc = { ...tc };
                    if (event.data.name && !tc.name) {
                      newTc.name = event.data.name;
                    }
                    if (event.data.argumentsDelta) {
                      newTc._argumentsRaw = (tc._argumentsRaw || '') + event.data.argumentsDelta;
                      // 尝试解析完整的 JSON
                      try {
                        newTc.arguments = JSON.parse(newTc._argumentsRaw);
                      } catch {
                        // JSON 还不完整，保持原样
                      }
                    }
                    return newTc;
                  }
                  return tc;
                });
                updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
              }
            }
            break;

          case 'tool_call_start':
            // 工具调用开始（来自 AgentLoop，表示工具即将执行）
            // 此时需要用后端的真实 ID 更新前端的临时 ID
            // event.data 包含: id, name, arguments, _index (工具在数组中的索引)
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              const toolIndex = event.data._index;
              logger.debug('tool_call_start', { index: toolIndex, id: event.data.id, name: event.data.name, targetMessageId });

              if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
                // 策略：优先用索引匹配，因为同一消息可能有多个同名工具调用
                if (toolIndex !== undefined && toolIndex < targetMessage.toolCalls.length) {
                  const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, idx: number) => {
                    if (idx === toolIndex) {
                      // 用后端的真实数据更新，保留前端已有的 arguments（流式解析的）
                      logger.debug('Updating tool call at index', { idx, oldId: tc.id, newId: event.data.id });
                      return {
                        ...tc,
                        id: event.data.id, // 关键：更新为后端的真实 ID
                        name: event.data.name || tc.name,
                        arguments: tc.arguments && Object.keys(tc.arguments).length > 0 ? tc.arguments : event.data.arguments,
                        _streaming: false, // 标记为非流式（已确定）
                      };
                    }
                    return tc;
                  });
                  updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
                } else {
                  // 索引不存在或超出范围，尝试按名称匹配 streaming 状态的工具调用
                  const streamingIndex = targetMessage.toolCalls.findIndex(
                    (tc: ToolCall) => tc._streaming && tc.name === event.data.name
                  );
                  if (streamingIndex >= 0) {
                    const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, idx: number) => {
                      if (idx === streamingIndex) {
                        return { ...tc, id: event.data.id, _streaming: false };
                      }
                      return tc;
                    });
                    updateMessage(targetMessage.id, { toolCalls: updatedToolCalls });
                  }
                }
              } else if (targetMessage?.role === 'assistant') {
                // 没有工具调用列表，直接添加
                updateMessage(targetMessage.id, {
                  toolCalls: [event.data],
                });
              }
            }
            break;

          case 'tool_call_end':
            // Update tool call result - search all messages to handle race conditions
            if (event.data) {
              const toolResult = event.data as ToolResult;

              if (import.meta.env.DEV) {
                logger.debug('tool_call_end received', {
                  toolCallId: toolResult.toolCallId,
                  success: toolResult.success,
                  duration: toolResult.duration,
                });
              }

              // Find and update the matching toolCall across all messages
              let matched = false;
              for (const msg of currentMessages) {
                if (msg.role === 'assistant' && msg.toolCalls) {
                  const hasMatch = msg.toolCalls.some((tc: ToolCall) => tc.id === toolResult.toolCallId);
                  if (hasMatch) {
                    matched = true;
                    const updatedToolCalls = msg.toolCalls.map((tc: ToolCall) =>
                      tc.id === toolResult.toolCallId
                        ? { ...tc, result: toolResult }
                        : tc
                    );
                    updateMessage(msg.id, { toolCalls: updatedToolCalls });
                    break;
                  }
                }
              }

              if (import.meta.env.DEV && !matched) {
                logger.warn('No matching toolCall found', { toolCallId: toolResult.toolCallId });
                logger.debug('Available toolCalls', {
                  ids: currentMessages
                    .filter(m => m.toolCalls)
                    .flatMap(m => m.toolCalls!.map(tc => tc.id))
                });
              }
            }
            break;

          case 'todo_update':
            // Update todos - only for current session (fix cross-session pollution)
            // Events from other sessions should be ignored
            if (event.data) {
              if (!event.sessionId || event.sessionId === currentSessionId) {
                setTodos(event.data);
              } else {
                logger.debug('Ignoring todo_update from different session', {
                  eventSessionId: event.sessionId,
                  currentSessionId
                });
              }
            }
            break;

          case 'error': {
            // Handle error - display it in the chat
            logger.error('Agent error', { message: event.data?.message, code: event.data?.code });
            // 只有当前会话的错误才更新消息
            if (!event.sessionId || event.sessionId === currentSessionId) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              if (lastMessage?.role === 'assistant') {
                // 根据错误类型生成友好的提示
                let errorContent: string;
                if (event.data?.code === 'CONTEXT_LENGTH_EXCEEDED') {
                  // 上下文超限错误：显示友好提示
                  const details = event.data.details;
                  const requestedK = details?.requested ? Math.round(details.requested / 1000) : '?';
                  const maxK = details?.max ? Math.round(details.max / 1000) : '?';
                  errorContent =
                    `⚠️ **${event.data.message}**\n\n` +
                    `当前对话长度约 ${requestedK}K tokens，超出模型限制 ${maxK}K tokens。\n\n` +
                    `${event.data.suggestion || '建议新开一个会话继续对话。'}`;
                } else {
                  // 其他错误：显示原始错误信息
                  errorContent = `Error: ${event.data?.message || 'Unknown error'}`;
                }
                updateMessage(lastMessage.id, { content: errorContent });
              }
            }
            clearSessionProcessing();
            break;
          }

          case 'agent_complete':
            // Agent has finished processing
            // 只有当前会话才刷新流式更新
            if (!event.sessionId || event.sessionId === currentSessionId) {
              flushRef.current();
            }
            clearSessionProcessing();
            break;

          case 'permission_request':
            // Handle permission request from tools
            // Show permission dialog to user for approval
            logger.debug('Permission request received', { data: event.data });
            if (event.data?.id) {
              // Set the pending permission request to show the modal
              setPendingPermissionRequest(event.data as PermissionRequest);
            }
            break;

          // ================================================================
          // 长时任务进度追踪
          // ================================================================

          case 'task_progress':
            // 更新任务进度状态
            if (event.data) {
              logger.debug('task_progress', { data: event.data });
              setTaskProgress(event.data as TaskProgressData);
            }
            break;

          case 'task_complete':
            // 任务完成
            if (event.data) {
              logger.debug('task_complete', { data: event.data });
              setLastTaskComplete(event.data as TaskCompleteData);
              // 清除进度状态
              setTaskProgress(null);

              // 跨会话未读通知：如果任务完成时用户已切换到其他会话，标记原会话为未读
              const taskSessionId = taskSessionIdRef.current;
              const currentSession = useSessionStore.getState().currentSessionId;
              if (taskSessionId && taskSessionId !== currentSession) {
                logger.debug('Task completed in different session, marking as unread', { taskSessionId });
                useSessionStore.getState().markSessionUnread(taskSessionId);
              }
              taskSessionIdRef.current = null;
            }
            break;

          // ================================================================
          // 语义研究检测
          // ================================================================

          case 'research_detected':
            // 语义检测到需要深度研究
            if (event.data) {
              logger.debug('research_detected', { data: event.data });
              setResearchDetected(event.data as ResearchDetectedData);
            }
            break;

          case 'research_mode_started':
            // 研究模式开始，清除检测状态
            setResearchDetected(null);
            break;
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [updateMessage, setTodos, setIsProcessing, setPendingPermissionRequest]); // Remove messages from deps to avoid re-registering

  // Send a message to the agent
  // Turn-based model: 不再预创建 placeholder，等待后端 turn_start 事件
  const sendMessage = useCallback(
    async (content: string, attachments?: MessageAttachment[]) => {
      logger.debug('sendMessage called', { contentPreview: content.substring(0, 50), sessionId: currentSessionId });

      // 检查当前会话是否正在处理（允许其他会话并发发送）
      const isCurrentSessionProcessing = currentSessionId
        ? useAppStore.getState().isSessionProcessing(currentSessionId)
        : isProcessing;

      if ((!content.trim() && !attachments?.length) || isCurrentSessionProcessing) {
        logger.debug('sendMessage blocked - empty or current session processing', { isCurrentSessionProcessing });
        return;
      }

      // 没有会话时无法发送
      if (!currentSessionId) {
        logger.warn('sendMessage blocked - no current session');
        return;
      }

      // Add user message with UUID
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        attachments,
      };
      logger.debug('Adding user message', { id: userMessage.id, attachmentsCount: attachments?.length || 0 });
      addMessage(userMessage);

      // 不再预创建 assistant placeholder
      // 后端会在每轮迭代开始时发送 turn_start 事件，前端据此创建消息
      // 这样可以确保：
      // 1. 每轮 Agent Loop 对应一条消息
      // 2. 工具调用后的新响应会创建新消息，而不是追加到旧消息

      // 按会话设置处理状态（允许多会话并发）
      setSessionProcessing(currentSessionId, true);
      currentTurnMessageIdRef.current = null; // 重置 turn tracking

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        logger.debug('Calling invoke agent:send-message');
        // 如果有附件，构建包含附件信息的消息
        const messagePayload = attachments?.length
          ? { content, attachments }
          : content;
        logger.debug('messagePayload', { type: typeof messagePayload, isObject: typeof messagePayload === 'object' });
        if (typeof messagePayload === 'object') {
          logger.debug('Attachments being sent', { attachments: attachments?.map(a => ({ name: a.name, category: a.category, hasData: !!a.data, dataLen: a.data?.length, path: a.path, hasPath: !!a.path })) });
        }
        await window.electronAPI?.invoke('agent:send-message', messagePayload);
        logger.debug('invoke returned');
      } catch (error) {
        logger.error('Agent error', error);
        // 错误时创建一条错误消息
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now(),
        };
        addMessage(errorMessage);
        // 按会话清除处理状态
        setSessionProcessing(currentSessionId, false);
      }
    },
    [addMessage, setSessionProcessing, isProcessing, currentSessionId]
  );

  // Cancel the current operation
  const cancel = useCallback(async () => {
    try {
      await window.electronAPI?.invoke('agent:cancel');
      // 按会话清除处理状态
      if (currentSessionId) {
        setSessionProcessing(currentSessionId, false);
      } else {
        setIsProcessing(false);
      }
    } catch (error) {
      logger.error('Cancel error', error);
    }
  }, [setIsProcessing, setSessionProcessing, currentSessionId]);

  // 清除语义研究检测状态
  const dismissResearchDetected = useCallback(() => {
    setResearchDetected(null);
  }, []);

  return {
    messages,
    isProcessing,
    sendMessage,
    cancel,
    currentGeneration,
    // 长时任务进度追踪
    taskProgress,
    lastTaskComplete,
    // 语义研究检测
    researchDetected,
    dismissResearchDetected,
  };
};
