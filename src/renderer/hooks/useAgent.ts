// ============================================================================
// useAgent - Agent Communication Hook
// ============================================================================

import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { generateMessageId } from '@shared/utils/id';
import type { Message, MessageAttachment, ToolCall, ToolResult, PermissionRequest } from '@shared/types';

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
          case 'stream_chunk':
            // Update the last assistant message with streaming content
            if (event.data?.content) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              if (lastMessage?.role === 'assistant') {
                updateMessage(lastMessage.id, {
                  content: (lastMessage.content || '') + event.data.content,
                });
              }
            }
            break;

          case 'message':
            // Message from assistant (could be text or tool calls)
            // 注意：流式输出时，文本内容已经通过 stream_chunk 接收了
            // 这里只需要更新工具调用，不要覆盖已有的流式内容
            if (event.data) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              if (lastMessage?.role === 'assistant') {
                // 如果已有流式内容，保留它；否则使用 event.data.content
                const existingContent = lastMessage.content || '';
                const newContent = event.data.content || '';

                updateMessage(lastMessage.id, {
                  // 优先保留已有的流式内容（通常更长）
                  content: existingContent.length >= newContent.length ? existingContent : newContent,
                  toolCalls: event.data.toolCalls || lastMessage.toolCalls,
                });
              }
              // Only stop processing if this is a text message (no tool calls)
              // Tool call messages will continue processing
              if (!event.data.toolCalls || event.data.toolCalls.length === 0) {
                setIsProcessing(false);
              }
            }
            break;

          case 'stream_tool_call_start':
            // 流式工具调用开始 - 立即显示工具调用（带 streaming 标记）
            if (event.data) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              console.log('[useAgent] stream_tool_call_start:', event.data);
              if (lastMessage?.role === 'assistant') {
                const newToolCall: ToolCall = {
                  id: event.data.id || `pending_${event.data.index}`,
                  name: event.data.name || '',
                  arguments: {},
                  _streaming: true, // 标记为流式中
                  _argumentsRaw: '', // 累积原始参数字符串
                };
                updateMessage(lastMessage.id, {
                  toolCalls: [...(lastMessage.toolCalls || []), newToolCall],
                });
              }
            }
            break;

          case 'stream_tool_call_delta':
            // 流式工具调用增量更新
            if (event.data) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              if (lastMessage?.role === 'assistant' && lastMessage.toolCalls) {
                const index = event.data.index ?? 0;
                const updatedToolCalls = lastMessage.toolCalls.map((tc: ToolCall, i: number) => {
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
                updateMessage(lastMessage.id, { toolCalls: updatedToolCalls });
              }
            }
            break;

          case 'tool_call_start':
            // 工具调用开始（来自 AgentLoop，表示工具即将执行）
            // 此时需要用后端的真实 ID 更新前端的临时 ID
            // event.data 包含: id, name, arguments, _index (工具在数组中的索引)
            if (event.data) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              const toolIndex = event.data._index;
              console.log('[useAgent] tool_call_start - index:', toolIndex, 'id:', event.data.id, 'name:', event.data.name);

              if (lastMessage?.role === 'assistant' && lastMessage.toolCalls) {
                // 策略：优先用索引匹配，因为同一消息可能有多个同名工具调用
                if (toolIndex !== undefined && toolIndex < lastMessage.toolCalls.length) {
                  const updatedToolCalls = lastMessage.toolCalls.map((tc: ToolCall, idx: number) => {
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
                  updateMessage(lastMessage.id, { toolCalls: updatedToolCalls });
                } else {
                  // 索引不存在或超出范围，尝试按名称匹配 streaming 状态的工具调用
                  const streamingIndex = lastMessage.toolCalls.findIndex(
                    (tc: ToolCall) => tc._streaming && tc.name === event.data.name
                  );
                  if (streamingIndex >= 0) {
                    const updatedToolCalls = lastMessage.toolCalls.map((tc: ToolCall, idx: number) => {
                      if (idx === streamingIndex) {
                        return { ...tc, id: event.data.id, _streaming: false };
                      }
                      return tc;
                    });
                    updateMessage(lastMessage.id, { toolCalls: updatedToolCalls });
                  }
                }
              } else if (lastMessage?.role === 'assistant') {
                // 没有工具调用列表，直接添加
                updateMessage(lastMessage.id, {
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
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [updateMessage, setTodos, setIsProcessing, setPendingPermissionRequest]); // Remove messages from deps to avoid re-registering

  // Send a message to the agent
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

      // Add placeholder assistant message for streaming with UUID
      const assistantMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [],
      };
      addMessage(assistantMessage);

      setIsProcessing(true);

      try {
        // Send to main process
        // Note: Don't set isProcessing to false here, it will be set by agent_complete event
        console.log('[useAgent] Calling invoke agent:send-message');
        // 如果有附件，构建包含附件信息的消息
        const messagePayload = attachments?.length
          ? { content, attachments }
          : content;
        await window.electronAPI?.invoke('agent:send-message', messagePayload);
        console.log('[useAgent] invoke returned');
      } catch (error) {
        console.error('[useAgent] Agent error:', error);
        updateMessage(assistantMessage.id, {
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
        setIsProcessing(false);
      }
    },
    [addMessage, updateMessage, setIsProcessing, isProcessing]
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
  };
};
