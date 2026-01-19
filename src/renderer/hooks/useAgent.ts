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
import type { Message, MessageAttachment, ToolCall, ToolResult, PermissionRequest, TaskProgressData, TaskCompleteData } from '@shared/types';

export const useAgent = () => {
  const {
    setIsProcessing,
    isProcessing,
    currentGeneration,
    setPendingPermissionRequest,
  } = useAppStore();

  const {
    messages,
    addMessage,
    updateMessage,
    setTodos,
  } = useSessionStore();

  // Use refs to avoid stale closure issues
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Track current turn's message ID for proper event routing
  const currentTurnMessageIdRef = useRef<string | null>(null);

  // 任务进度状态（长时任务反馈）
  const [taskProgress, setTaskProgress] = useState<TaskProgressData | null>(null);
  const [lastTaskComplete, setLastTaskComplete] = useState<TaskCompleteData | null>(null);

  // Listen for agent events from the main process
  // Only register once, use refs to access latest state
  useEffect(() => {
    const unsubscribe = window.electronAPI?.on(
      'agent:event',
      (event: { type: string; data: any }) => {
        console.log('[useAgent] Received event:', event.type, event.data);

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
              console.log('[useAgent] turn_start - created message:', turnId);
            }
            break;

          case 'stream_chunk':
            // 流式文本内容 - 追加到当前 turn 的消息
            if (event.data?.content) {
              // 优先使用 turnId 定位消息，fallback 到最后一条 assistant 消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              if (targetMessage?.role === 'assistant') {
                updateMessage(targetMessage.id, {
                  content: (targetMessage.content || '') + event.data.content,
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
                    updateMessage(lastMessage.id, {
                      content: (lastMessage.content || '') + event.data.content,
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
                setIsProcessing(false);
              }
            }
            break;

          case 'turn_end':
            // 本轮 Agent Loop 结束
            // 可用于清理状态或触发 UI 更新
            console.log('[useAgent] turn_end:', event.data?.turnId);
            break;

          case 'stream_tool_call_start':
            // 流式工具调用开始 - 立即显示工具调用（带 streaming 标记）
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? currentMessages.find(m => m.id === targetMessageId)
                : currentMessages[currentMessages.length - 1];

              console.log('[useAgent] stream_tool_call_start:', event.data, 'targetMessageId:', targetMessageId);
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
              console.log('[useAgent] tool_call_start - index:', toolIndex, 'id:', event.data.id, 'name:', event.data.name, 'targetMessageId:', targetMessageId);

              if (targetMessage?.role === 'assistant' && targetMessage.toolCalls) {
                // 策略：优先用索引匹配，因为同一消息可能有多个同名工具调用
                if (toolIndex !== undefined && toolIndex < targetMessage.toolCalls.length) {
                  const updatedToolCalls = targetMessage.toolCalls.map((tc: ToolCall, idx: number) => {
                    if (idx === toolIndex) {
                      // 用后端的真实数据更新，保留前端已有的 arguments（流式解析的）
                      console.log('[useAgent] Updating tool call at index', idx, ':', tc.id, '->', event.data.id);
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
                console.log('[useAgent] tool_call_end received:', {
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
                console.warn('[useAgent] No matching toolCall found for:', toolResult.toolCallId);
                console.log('[useAgent] Available toolCalls:',
                  currentMessages
                    .filter(m => m.toolCalls)
                    .flatMap(m => m.toolCalls!.map(tc => tc.id))
                );
              }
            }
            break;

          case 'todo_update':
            // Update todos
            if (event.data) {
              setTodos(event.data);
            }
            break;

          case 'error':
            // Handle error - display it in the chat
            console.error('Agent error:', event.data?.message);
            const lastMessage = currentMessages[currentMessages.length - 1];
            if (lastMessage?.role === 'assistant') {
              updateMessage(lastMessage.id, {
                content: `Error: ${event.data?.message || 'Unknown error'}`,
              });
            }
            setIsProcessing(false);
            break;

          case 'agent_complete':
            // Agent has finished processing
            setIsProcessing(false);
            break;

          case 'permission_request':
            // Handle permission request from tools
            // Show permission dialog to user for approval
            console.log('[useAgent] Permission request received:', event.data);
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
              console.log('[useAgent] task_progress:', event.data);
              setTaskProgress(event.data as TaskProgressData);
            }
            break;

          case 'task_complete':
            // 任务完成
            if (event.data) {
              console.log('[useAgent] task_complete:', event.data);
              setLastTaskComplete(event.data as TaskCompleteData);
              // 清除进度状态
              setTaskProgress(null);
            }
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
      console.log('[useAgent] sendMessage called with:', content.substring(0, 50));
      if ((!content.trim() && !attachments?.length) || isProcessing) {
        console.log('[useAgent] sendMessage blocked - empty or processing');
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
      console.log('[useAgent] Adding user message with id:', userMessage.id, 'attachments:', attachments?.length || 0);
      addMessage(userMessage);

      // 不再预创建 assistant placeholder
      // 后端会在每轮迭代开始时发送 turn_start 事件，前端据此创建消息
      // 这样可以确保：
      // 1. 每轮 Agent Loop 对应一条消息
      // 2. 工具调用后的新响应会创建新消息，而不是追加到旧消息

      setIsProcessing(true);
      currentTurnMessageIdRef.current = null; // 重置 turn tracking

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        console.log('[useAgent] Calling invoke agent:send-message');
        // 如果有附件，构建包含附件信息的消息
        const messagePayload = attachments?.length
          ? { content, attachments }
          : content;
        console.log('[useAgent] messagePayload type:', typeof messagePayload, 'isObject:', typeof messagePayload === 'object');
        if (typeof messagePayload === 'object') {
          console.log('[useAgent] Attachments being sent:', attachments?.map(a => ({ name: a.name, category: a.category, hasData: !!a.data, dataLen: a.data?.length, path: a.path, hasPath: !!a.path })));
        }
        await window.electronAPI?.invoke('agent:send-message', messagePayload);
        console.log('[useAgent] invoke returned');
      } catch (error) {
        console.error('[useAgent] Agent error:', error);
        // 错误时创建一条错误消息
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: Date.now(),
        };
        addMessage(errorMessage);
        setIsProcessing(false);
      }
    },
    [addMessage, setIsProcessing, isProcessing]
  );

  // Cancel the current operation
  const cancel = useCallback(async () => {
    try {
      await window.electronAPI?.invoke('agent:cancel');
      setIsProcessing(false);
    } catch (error) {
      console.error('Cancel error:', error);
    }
  }, [setIsProcessing]);

  return {
    messages,
    isProcessing,
    sendMessage,
    cancel,
    currentGeneration,
    // 长时任务进度追踪
    taskProgress,
    lastTaskComplete,
  };
};
