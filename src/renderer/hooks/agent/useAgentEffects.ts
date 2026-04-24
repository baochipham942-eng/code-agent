// useAgentEffects owns event subscriptions, permission queue routing, and stale-processing cleanup.
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type { Message, PermissionRequest, ResearchDetectedData, ToolCall, ToolProgressData, ToolResult, ToolTimeoutData } from '@shared/contract';
import { createLogger } from '../../utils/logger';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTurnExecutionStore } from '../../stores/turnExecutionStore';
import ipcService from '../../services/ipcService';
import type { MessageUpdate } from '../useMessageBatcher';

const logger = createLogger('useAgent');
const GLOBAL_PERMISSION_REQUEST_SESSION_ID = 'global';

type AppStoreState = ReturnType<typeof useAppStore.getState>;
type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

interface UseAgentEffectsArgs {
  addMessage: SessionStoreState['addMessage'];
  currentSessionId: string | null;
  currentTurnMessageIdRef: MutableRefObject<string | null>;
  enqueuePermissionRequest: AppStoreState['enqueuePermissionRequest'];
  flushRef: MutableRefObject<() => void>;
  lastEventAtRef: MutableRefObject<number>;
  pendingPermissionRequest: AppStoreState['pendingPermissionRequest'];
  pendingPermissionSessionId: AppStoreState['pendingPermissionSessionId'];
  queueUpdate: (update: MessageUpdate) => void;
  setActiveToolProgress: Dispatch<SetStateAction<ToolProgressData | null>>;
  setIsInterrupting: Dispatch<SetStateAction<boolean>>;
  setIsProcessing: AppStoreState['setIsProcessing'];
  setPendingPermissionRequest: AppStoreState['setPendingPermissionRequest'];
  setResearchDetected: Dispatch<SetStateAction<ResearchDetectedData | null>>;
  setSessionTaskComplete: AppStoreState['setSessionTaskComplete'];
  setSessionTaskProgress: AppStoreState['setSessionTaskProgress'];
  setTodos: SessionStoreState['setTodos'];
  setToolTimeoutWarning: Dispatch<SetStateAction<ToolTimeoutData | null>>;
  shiftQueuedPermissionRequest: AppStoreState['shiftQueuedPermissionRequest'];
  updateMessage: SessionStoreState['updateMessage'];
}

export function useAgentEffects({
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
}: UseAgentEffectsArgs) {
  useEffect(() => {
    if (
      pendingPermissionRequest &&
      pendingPermissionSessionId &&
      pendingPermissionSessionId !== GLOBAL_PERMISSION_REQUEST_SESSION_ID &&
      currentSessionId &&
      pendingPermissionSessionId !== currentSessionId
    ) {
      enqueuePermissionRequest(pendingPermissionSessionId, pendingPermissionRequest, { front: true });
      setPendingPermissionRequest(null);
      return;
    }

    if (!pendingPermissionRequest) {
      const nextCurrentRequest = currentSessionId
        ? shiftQueuedPermissionRequest(currentSessionId)
        : null;
      const nextGlobalRequest = shiftQueuedPermissionRequest(GLOBAL_PERMISSION_REQUEST_SESSION_ID);
      const nextRequest = nextCurrentRequest || nextGlobalRequest;

      if (nextRequest) {
        setPendingPermissionRequest(nextRequest, nextCurrentRequest ? currentSessionId : null);
      }
    }
  }, [
    currentSessionId,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    enqueuePermissionRequest,
    shiftQueuedPermissionRequest,
    setPendingPermissionRequest,
  ]);

  // Listen for agent events from the main process
  // Only register once, use refs to access latest state
  // 心跳：每收到 SSE 事件更新时间戳；下方 idle-timer 检查超时

  useEffect(() => {
    const unsubscribe = ipcService.on(
      'agent:event',
      (event: { type: string; data: any; sessionId?: string }) => {
        lastEventAtRef.current = Date.now();
        // 只对非流式事件打印日志，避免控制台刷屏
        const silentEvents = ['stream_chunk', 'stream_reasoning', 'stream_tool_call_delta'];
        if (!silentEvents.includes(event.type)) {
          logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
        }

        const currentSessionId = useSessionStore.getState().currentSessionId;
        const eventSessionId = event.sessionId || currentSessionId || null;
        const isCurrentSessionEvent = !eventSessionId || eventSessionId === currentSessionId;

        // 辅助函数：清除会话处理状态
        const clearSessionProcessing = () => {
          const sessionId = eventSessionId;
          if (sessionId) {
            useAppStore.getState().setSessionProcessing(sessionId, false);
          } else {
            setIsProcessing(false);
          }
        };

        // Always get fresh messages from store to avoid stale closures
        // (the closure-captured ref may not reflect messages added during this event cycle)
        const getFreshMessages = () => useSessionStore.getState().messages;

        switch (event.type) {
          // ================================================================
          // Turn-based message handling (行业最佳实践)
          // ================================================================

          case 'turn_start':
            // 新一轮 Agent Loop 开始 - 创建新的 assistant 消息
            // 这是后端驱动的消息创建，确保每轮对应一条消息
            {
              if (!isCurrentSessionEvent) {
                break;
              }
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
              logger.debug('turn_start - created message', { turnId, sessionId: eventSessionId });
            }
            break;

          case 'stream_chunk':
            // 流式文本内容 - 追加到当前 turn 的消息（使用批处理优化）
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data?.content) {
              // 优先使用 turnId 定位消息，fallback 到最后一条 assistant 消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const freshMsgs = getFreshMessages();
              const targetMessage = targetMessageId
                ? freshMsgs.find(m => m.id === targetMessageId)
                : freshMsgs[freshMsgs.length - 1];

              if (targetMessage?.role === 'assistant') {
                queueUpdate({
                  type: 'append',
                  messageId: targetMessage.id,
                  content: event.data.content,
                });
              } else {
                // Fallback: 如果没有找到目标消息，创建一个新的（兼容旧事件格式）
                const lastMessage = getFreshMessages()[getFreshMessages().length - 1];
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
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data) {
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? getFreshMessages().find(m => m.id === targetMessageId)
                : getFreshMessages()[getFreshMessages().length - 1];

              if (targetMessage?.role === 'assistant') {
                // 保留已有的流式内容
                const existingContent = targetMessage.content || '';
                const newContent = event.data.content || '';

                // message 事件的 toolCalls 来自模型 API 响应，只有调用请求（name+args），
                // 没有执行结果（result）。前端 toolCalls 已通过 tool_call_end 事件积累了 result。
                // 必须合并而非覆盖，否则已完成的工具调用会丢失 result 变成"幽灵 pending"。
                let mergedToolCalls = targetMessage.toolCalls;
                if (event.data.toolCalls && event.data.toolCalls.length > 0) {
                  const existingToolCalls = targetMessage.toolCalls || [];
                  if (existingToolCalls.length > 0) {
                    // 保留前端已有的 toolCalls（含 result），仅补充新增的
                    const existingIds = new Set(existingToolCalls.map((tc: ToolCall) => tc.id));
                    const newOnes = event.data.toolCalls.filter((tc: ToolCall) => !existingIds.has(tc.id));
                    mergedToolCalls = [...existingToolCalls, ...newOnes];
                  } else {
                    mergedToolCalls = event.data.toolCalls;
                  }
                }

                updateMessage(targetMessage.id, {
                  content: existingContent.length >= newContent.length ? existingContent : newContent,
                  toolCalls: mergedToolCalls,
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
            if (!isCurrentSessionEvent) {
              break;
            }
            flushRef.current();
            logger.debug('turn_end', { turnId: event.data?.turnId });
            break;

          case 'routing_resolved':
            if (eventSessionId && event.data?.mode === 'auto') {
              useTurnExecutionStore.getState().recordRoutingEvidence(eventSessionId, {
                kind: 'auto',
                mode: 'auto',
                timestamp: event.data.timestamp || Date.now(),
                agentId: event.data.agentId,
                agentName: event.data.agentName,
                reason: event.data.reason,
                score: event.data.score,
                fallbackToDefault: event.data.fallbackToDefault,
              });
            }
            break;

          case 'stream_reasoning':
            // 推理模型的思考过程 (glm-4.7 等) - 存储到单独的 reasoning 字段
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data?.content) {
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? getFreshMessages().find(m => m.id === targetMessageId)
                : getFreshMessages()[getFreshMessages().length - 1];

              if (targetMessage?.role === 'assistant') {
                queueUpdate({
                  type: 'append',
                  messageId: targetMessage.id,
                  reasoning: event.data.content,
                });
              }
            }
            break;

          case 'stream_tool_call_start':
            // 流式工具调用开始 - 立即显示工具调用（带 streaming 标记）
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? getFreshMessages().find(m => m.id === targetMessageId)
                : getFreshMessages()[getFreshMessages().length - 1];

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
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? getFreshMessages().find(m => m.id === targetMessageId)
                : getFreshMessages()[getFreshMessages().length - 1];

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
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data) {
              // 使用 turnId 定位目标消息
              const targetMessageId = event.data.turnId || currentTurnMessageIdRef.current;
              const targetMessage = targetMessageId
                ? getFreshMessages().find(m => m.id === targetMessageId)
                : getFreshMessages()[getFreshMessages().length - 1];

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
            if (!isCurrentSessionEvent) {
              break;
            }
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
              for (const msg of getFreshMessages()) {
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
                  ids: getFreshMessages()
                    .filter(m => m.toolCalls)
                    .flatMap(m => m.toolCalls!.map(tc => tc.id))
                });
              }

              // Clear tool progress/timeout state for this completed tool
              setActiveToolProgress((prev) => prev?.toolCallId === toolResult.toolCallId ? null : prev);
              setToolTimeoutWarning((prev) => prev?.toolCallId === toolResult.toolCallId ? null : prev);
            }
            break;

          case 'todo_update':
            // Update todos - only for current session (fix cross-session pollution)
            // Events from other sessions should be ignored
            if (event.data && isCurrentSessionEvent) {
              // SSE wraps array data as { items: [...], sessionId } — unwrap back to TodoItem[]
              const todos = Array.isArray(event.data) ? event.data : event.data.items;
              if (todos) setTodos(todos);
            }
            break;

          case 'error': {
            // Handle error - display it in the chat
            logger.error('Agent error', { message: event.data?.message, code: event.data?.code });
            // 只有当前会话的错误才更新消息
            if (isCurrentSessionEvent) {
              const lastMessage = getFreshMessages()[getFreshMessages().length - 1];
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
            if (isCurrentSessionEvent) {
              flushRef.current();
              setActiveToolProgress(null);
              setToolTimeoutWarning(null);
            }
            clearSessionProcessing();
            if (eventSessionId) {
              setSessionTaskProgress(eventSessionId, null);
            }
            break;

          case 'permission_request':
            // Handle permission request from tools
            // Show permission dialog to user for approval
            logger.debug('Permission request received', { data: event.data });
            if (event.data?.id) {
              const rawPermissionSessionId = event.sessionId;
              const isGlobalPermissionRequest =
                !rawPermissionSessionId ||
                rawPermissionSessionId === GLOBAL_PERMISSION_REQUEST_SESSION_ID;

              if (isGlobalPermissionRequest) {
                if (!useAppStore.getState().pendingPermissionRequest) {
                  setPendingPermissionRequest(event.data as PermissionRequest, null);
                } else {
                  enqueuePermissionRequest(
                    GLOBAL_PERMISSION_REQUEST_SESSION_ID,
                    event.data as PermissionRequest
                  );
                }
                break;
              }

              if (isCurrentSessionEvent && !useAppStore.getState().pendingPermissionRequest) {
                setPendingPermissionRequest(event.data as PermissionRequest, rawPermissionSessionId);
              } else {
                enqueuePermissionRequest(rawPermissionSessionId, event.data as PermissionRequest);
                useSessionStore.getState().markSessionUnread(rawPermissionSessionId);
              }
            }
            break;

          // ================================================================
          // 长时任务进度追踪
          // ================================================================

          case 'task_progress':
            // 更新任务进度状态
            if (event.data && eventSessionId) {
              logger.debug('task_progress', { data: event.data });
              setSessionTaskProgress(eventSessionId, event.data);
              setSessionTaskComplete(eventSessionId, null);
            }
            break;

          case 'task_complete':
            // 任务完成
            if (event.data && eventSessionId) {
              logger.debug('task_complete', { data: event.data });
              setSessionTaskComplete(eventSessionId, event.data);
              setSessionTaskProgress(eventSessionId, null);

              if (!isCurrentSessionEvent) {
                logger.debug('Task completed in different session, marking as unread', { eventSessionId });
                useSessionStore.getState().markSessionUnread(eventSessionId);
              }
            }
            break;

          // ================================================================
          // 语义研究检测
          // ================================================================

          case 'research_detected':
            // 语义检测到需要深度研究
            if (!isCurrentSessionEvent) {
              break;
            }
            if (event.data) {
              logger.debug('research_detected', { data: event.data });
              setResearchDetected(event.data as ResearchDetectedData);
            }
            break;

          case 'research_mode_started':
            // 研究模式开始，清除检测状态
            if (!isCurrentSessionEvent) {
              break;
            }
            setResearchDetected(null);
            break;

          // ================================================================
          // 工具执行进度 & 超时
          // ================================================================

          case 'tool_progress':
            if (event.data) {
              if (!isCurrentSessionEvent) {
                break;
              }
              setActiveToolProgress(event.data as ToolProgressData);
            }
            break;

          case 'tool_timeout':
            if (event.data) {
              if (!isCurrentSessionEvent) {
                break;
              }
              logger.debug('tool_timeout', { data: event.data });
              setToolTimeoutWarning(event.data as ToolTimeoutData);
            }
            break;

          // ================================================================
          // 中断事件（Claude Code 风格）
          // ================================================================

          case 'interrupt_start':
            // 中断开始
            if (!isCurrentSessionEvent) {
              break;
            }
            logger.debug('interrupt_start', { data: event.data });
            setIsInterrupting(true);
            break;

          case 'interrupt_acknowledged':
            // 中断已确认，当前任务正在停止
            if (!isCurrentSessionEvent) {
              break;
            }
            logger.debug('interrupt_acknowledged', { data: event.data });
            break;

          case 'interrupt_complete':
            // 中断完成，新任务即将开始
            if (!isCurrentSessionEvent) {
              break;
            }
            logger.debug('interrupt_complete', { data: event.data });
            setIsInterrupting(false);
            break;

          case 'tool_call_local':
            // Bridge 本地工具调用请求 - 通知 ChatView 检查 Bridge 状态
            if (!isCurrentSessionEvent) {
              break;
            }
            window.dispatchEvent(new CustomEvent('bridge-tool-call', { detail: event.data }));
            break;

          case 'stream_end':
            // SSE 流结束兜底（httpTransport 在流关闭时派发）
            // 如果 agent_complete 已经处理过则 processing 已清除，这里是安全的二次检查
            if (!isCurrentSessionEvent) {
              clearSessionProcessing();
              break;
            }
            logger.debug('stream_end - ensuring processing state is cleared');
            flushRef.current();
            clearSessionProcessing();
            break;
        }
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [
    updateMessage,
    setTodos,
    setIsProcessing,
    setPendingPermissionRequest,
    enqueuePermissionRequest,
    setSessionTaskProgress,
    setSessionTaskComplete,
  ]); // Remove messages from deps to avoid re-registering

  // Idle-timer 兜底：isProcessing 持续 5 分钟无任何 SSE 事件 → 视为 stuck，强制清状态
  // 防 dev server 重启 / 网络断开 / agent loop hang 导致 UI 永远转圈
  useEffect(() => {
    const STALE_MS = 5 * 60 * 1000;
    const CHECK_INTERVAL_MS = 30_000;
    const timer = setInterval(() => {
      const appState = useAppStore.getState();
      const hasProcessing = appState.isProcessing || appState.processingSessionIds.size > 0;
      if (!hasProcessing) return;
      const idleMs = Date.now() - lastEventAtRef.current;
      if (idleMs < STALE_MS) return;
      logger.warn(`[useAgent] No SSE events for ${Math.round(idleMs / 1000)}s while processing — auto-clearing stale state`);
      Array.from(appState.processingSessionIds).forEach((sid) => appState.setSessionProcessing(sid, false));
      appState.setIsProcessing(false);
      lastEventAtRef.current = Date.now();
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
}
