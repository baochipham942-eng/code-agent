// ============================================================================
// useAgent - Agent Communication Hook
// ============================================================================

import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { generateMessageId } from '@shared/utils/id';
import type { Message, ToolCall, ToolResult } from '@shared/types';

export const useAgent = () => {
  const {
    setIsProcessing,
    isProcessing,
    currentGeneration,
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
            if (event.data) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              if (lastMessage?.role === 'assistant') {
                updateMessage(lastMessage.id, {
                  content: event.data.content || lastMessage.content,
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

          case 'tool_call_start':
            // Add tool call to the last message
            if (event.data) {
              const lastMessage = currentMessages[currentMessages.length - 1];
              console.log('[useAgent] tool_call_start - lastMessage:', lastMessage?.id, 'event.data:', event.data);
              if (lastMessage?.role === 'assistant') {
                updateMessage(lastMessage.id, {
                  toolCalls: [...(lastMessage.toolCalls || []), event.data],
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
            // TODO: Show a proper permission dialog to the user
            // For now, auto-approve all permissions (development mode)
            console.log('[useAgent] Permission request received:', event.data);
            if (event.data?.id) {
              // Auto-approve the permission request
              // IPC signature: (requestId: string, response: PermissionResponse)
              console.log('[useAgent] Auto-approving permission:', event.data.id);
              window.electronAPI?.invoke('agent:permission-response', event.data.id, 'allow');
            }
            break;
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [updateMessage, setTodos, setIsProcessing]); // Remove messages from deps to avoid re-registering

  // Send a message to the agent
  const sendMessage = useCallback(
    async (content: string) => {
      console.log('[useAgent] sendMessage called with:', content.substring(0, 50));
      if (!content.trim() || isProcessing) {
        console.log('[useAgent] sendMessage blocked - empty or processing');
        return;
      }

      // Add user message with UUID
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };
      console.log('[useAgent] Adding user message with id:', userMessage.id);
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
        await window.electronAPI?.invoke('agent:send-message', content);
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
