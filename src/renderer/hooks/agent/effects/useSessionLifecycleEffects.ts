// useAgentSessionLifecycleEffects - agent_complete, error, stream_end, message completion, research_detected, research_mode_started, interrupt_start, interrupt_acknowledged, interrupt_complete, stale processing cleanup
import { useEffect } from 'react';
import type { AgentErrorMetadata, AgentEventEnvelope, ResearchDetectedData } from '@shared/contract';
import {
  classifyAgentError,
  getAgentErrorMessage,
  isTerminalAgentError,
  normalizeAgentErrorPayload,
} from '@shared/utils/agentErrorClassification';
import { createLogger } from '../../../utils/logger';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useStreamResumeStore } from '../../../stores/streamResumeStore';
import { useTaskStore, type SessionStatus } from '../../../stores/taskStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';
// 草稿清理规则只有一份：这里原来复制了一个同名函数，改了流式那份也修不到停止这条路。
import { removeUncommittedAssistantDraft } from './useConversationStreamEffects';

const logger = createLogger('useAgent');

type AgentEvent = AgentEventEnvelope | { type: 'stream_end'; data: null; sessionId?: string };

// 分类逻辑已迁 @shared/utils/agentErrorClassification（host 侧落库失败终态要用同一份，
// 两边漂移会让同一次失败在刷新前后显示不同的出路）。这里 re-export 维持既有
// import 路径（useAgentHalo / 测试）不动。
export {
  classifyAgentError,
  getAgentErrorMessage,
  isTerminalAgentError,
  normalizeAgentErrorPayload,
};

/**
 * 把结构化错误挂到最后一条 assistant 消息的 metadata 上（AgentErrorCard 渲染源）。
 * 错误若发生在任何 assistant 草稿之前（如首轮请求直接 404），补一条空 assistant
 * 消息承载卡片——否则这次失败在会话区完全不可见。
 */
export function attachAgentErrorToLatestAssistant(agentError: AgentErrorMetadata): void {
  const store = useSessionStore.getState();
  const messages = store.messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant') {
    // 一次失败会从多个出口各发一条 error，后到的会覆盖先到的。谁带了这一轮真跑的
    // 模型谁更有信息量——别让一条「只有 message」的把带了 provider/model 的盖掉。
    const existing = lastMessage.metadata?.agentError;
    const merged: AgentErrorMetadata = {
      ...(existing?.provider && !agentError.provider
        ? { ...agentError, provider: existing.provider, modelId: existing.modelId ?? agentError.modelId }
        : agentError),
      ...(existing?.goalAbort || agentError.goalAbort ? { goalAbort: true } : {}),
    };
    store.updateMessage(lastMessage.id, {
      metadata: { ...lastMessage.metadata, agentError: merged },
    });
    return;
  }
  store.addMessage({
    id: `agent-error-${agentError.timestamp}`,
    role: 'assistant',
    content: '',
    timestamp: agentError.timestamp,
    metadata: { agentError },
  });
}

/**
 * 这条 `message` 事件是不是「模型这一轮说完了」——只有它才该把运行态放下。
 *
 * 只认 assistant：宿主自起的轮次会在轮次**开头**广播一条 user 消息给前端补气泡，
 * 把它当轮末就是当场显示空闲、停止按钮消失，而后台还在跑（C3 那一族的老症状）。
 * 带 toolCalls 的 assistant 也不算——那是这一轮中间的工具调用。
 */
export function endsTheTurn(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const message = data as { role?: string; toolCalls?: unknown[] };
  if (message.role === 'user') return false;
  return !message.toolCalls || message.toolCalls.length === 0;
}

function clearRuntimeSessionState(sessionId: string): void {
  const currentStatus = useTaskStore.getState().sessionStates[sessionId]?.status;
  const shouldClear: SessionStatus[] = ['running', 'paused', 'queued', 'cancelling'];
  if (!currentStatus || shouldClear.includes(currentStatus)) {
    useTaskStore.getState().updateSessionState(sessionId, { status: 'idle' });
  }
}

function markRuntimeSessionCancelled(sessionId: string): void {
  useTaskStore.getState().updateSessionState(sessionId, { status: 'cancelled' });
}

function markLatestUserTurnCancelled(
  draftMessageId: string | null | undefined,
  cancelledAt: number,
): void {
  const store = useSessionStore.getState();
  const messages = store.messages;
  let latestUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.isMeta) {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) return;

  const markedMessages = messages.map((message, index) => {
    if (index !== latestUserIndex) return message;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        workbench: {
          ...message.metadata?.workbench,
          runCancellation: {
            status: 'cancelled' as const,
            cancelledAt,
            reason: 'user_cancelled',
          },
        },
      },
    };
  });

  store.setMessages(removeUncommittedAssistantDraft(markedMessages, draftMessageId));
}

export const useSessionLifecycleEffects = ({
  currentTurnMessageIdRef,
  flushRef,
  lastEventAtRef,
  setActiveToolProgress,
  setIsInterrupting,
  setIsProcessing,
  setResearchDetected,
  setSessionTaskComplete,
  setSessionTaskProgress,
  setTodos,
  setToolTimeoutWarning,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
  updateMessage,
}: AgentEffectsProps) => {
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const eventSessionId = getAgentEventSessionId(event);
      const isCurrentSessionEvent = isAgentEventForCurrentSession(event, currentSessionId);
      const clearSessionProcessing = () => {
        const sessionId = eventSessionId;
        if (sessionId) {
          useAppStore.getState().setSessionProcessing(sessionId, false);
        } else {
          setIsProcessing(false);
        }
      };
      const refreshContextHealth = () => {
        if (!isCurrentSessionEvent || !eventSessionId) return;
        useSessionStore.getState().refreshContextHealth(eventSessionId).catch((error) => {
          logger.warn('Failed to refresh context health after agent event', {
            sessionId: eventSessionId,
            eventType: event.type,
            error,
          });
        });
      };
      const logHandledEvent = () => {
        logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
      };

      switch (event.type) {
        case 'message':
          lastEventAtRef.current = Date.now();
          if (endsTheTurn(event.data)) {
            clearSessionProcessing();
          }
          break;

        case 'error':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isTerminalAgentError(event.data)) {
            logger.warn('Agent warning', {
              message: getAgentErrorMessage(event.data),
              code: normalizeAgentErrorPayload(event.data).code,
            });
            break;
          }
          logger.error('Agent error', {
            message: getAgentErrorMessage(event.data),
            code: normalizeAgentErrorPayload(event.data).code,
          });
          if (isCurrentSessionEvent) {
            // 结构化错误卡片：不再把友好文案 merge 进 content，而是在最后一条
            // assistant 消息的 metadata 写 agentError，渲染层据此渲染 AgentErrorCard
            // （带重试/切换模型/新开会话/复制错误报告按钮）。content 保持原样。
            const agentError = classifyAgentError(event.data, {
              modelId: useAppStore.getState().modelConfig.model,
            });
            if (agentError) {
              attachAgentErrorToLatestAssistant(agentError);
            }
          }
          // ADR-068 刀 4：预算耗尽转 error——断流续接信号让位给错误呈现（AgentErrorCard
          // 带重试动作衔接既有错误呈现，partial 刀 3 已带标记落库）。
          useStreamResumeStore.getState().clear();
          clearSessionProcessing();
          refreshContextHealth();
          break;

        case 'agent_complete':
        case 'agent_cancelled':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          // ADR-068 刀 4：run 终态——断流续接信号兜底消除（正常恢复早在续答 delta 到达时消过）
          useStreamResumeStore.getState().clear();
          if (isCurrentSessionEvent) {
            flushRef.current();
            setActiveToolProgress(null);
            setToolTimeoutWarning(null);
            if (event.type === 'agent_cancelled') {
              markLatestUserTurnCancelled(currentTurnMessageIdRef.current, Date.now());
              currentTurnMessageIdRef.current = null;
            }
          }
          clearSessionProcessing();
          if (eventSessionId) {
            if (event.type === 'agent_cancelled') {
              markRuntimeSessionCancelled(eventSessionId);
            } else {
              clearRuntimeSessionState(eventSessionId);
            }
          }
          if (eventSessionId) {
            setSessionTaskProgress(eventSessionId, null);
          }
          refreshContextHealth();
          break;

        case 'research_detected':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          if (event.data) {
            logger.debug('research_detected', { data: event.data });
            setResearchDetected(event.data as ResearchDetectedData);
          }
          break;

        case 'research_mode_started':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          setResearchDetected(null);
          break;

        case 'interrupt_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          logger.debug('interrupt_start', { data: event.data });
          setIsInterrupting(true);
          break;

        case 'interrupt_acknowledged':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          logger.debug('interrupt_acknowledged', { data: event.data });
          break;

        case 'interrupt_complete':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          logger.debug('interrupt_complete', { data: event.data });
          setIsInterrupting(false);
          break;

        case 'stream_end':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            clearSessionProcessing();
            break;
          }
          logger.debug('stream_end - ensuring processing state is cleared');
          flushRef.current();
          clearSessionProcessing();
          refreshContextHealth();
          break;

        default:
          lastEventAtRef.current = Date.now();
          break;
      }
    });

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
  ]);

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
};
