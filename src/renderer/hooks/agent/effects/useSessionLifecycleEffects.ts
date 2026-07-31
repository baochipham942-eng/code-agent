// useAgentSessionLifecycleEffects - agent_complete, error, stream_end, message completion, research_detected, research_mode_started, interrupt_start, interrupt_acknowledged, interrupt_complete, stale processing cleanup
import { useEffect } from 'react';
import type { AgentErrorMetadata, AgentEventEnvelope, Message, ResearchDetectedData } from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTaskStore, type SessionStatus } from '../../../stores/taskStore';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';

const logger = createLogger('useAgent');

type AgentEvent = AgentEventEnvelope | { type: 'stream_end'; data: null; sessionId?: string };

type AgentErrorPayload = Record<string, unknown>;

function isRecord(value: unknown): value is AgentErrorPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentErrorPayload(data: unknown): AgentErrorPayload {
  if (!isRecord(data)) return {};
  const nested = isRecord(data.data) ? data.data : {};
  return { ...data, ...nested };
}

function getNumberPayloadField(data: unknown, field: string): number | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === 'number' ? value : undefined;
}

export function getAgentErrorMessage(data: unknown): string | null {
  const payload = normalizeAgentErrorPayload(data);
  const message = typeof payload.message === 'string'
    ? payload.message.trim()
    : typeof payload.error === 'string'
      ? payload.error.trim()
      : '';
  return message || null;
}

export function isTerminalAgentError(data: unknown): boolean {
  const payload = normalizeAgentErrorPayload(data);
  return payload.terminal !== false
    && payload.level !== 'warning'
    && payload.severity !== 'warning';
}

function isGenericRunFailure(payload: AgentErrorPayload): boolean {
  return payload.code === 'RUN_FAILED' || typeof payload.code !== 'string';
}

function getStringPayloadField(data: unknown, field: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 把 agent error 事件分类成结构化错误（写进 message.metadata.agentError，由
 * AgentErrorCard 渲染）。title/suggestion 文案不在这里生成——文案随 i18n 走，
 * 分类只产出 category + 排障字段，卡片渲染时按 category 查表。
 */
export function classifyAgentError(
  data: unknown,
  context?: { modelId?: string },
): AgentErrorMetadata | null {
  const payload = normalizeAgentErrorPayload(data);
  const message = getAgentErrorMessage(payload);
  if (!message) return null;

  const base = {
    code: typeof payload.code === 'string' ? payload.code : undefined,
    traceId: getStringPayloadField(payload, 'traceId') ?? getStringPayloadField(payload, 'requestId'),
    rawMessage: message,
    // host 在失败事件里带的是这一轮真跑的模型，优先用它；context 是前端当前选中的
    // 模型，刚切过模型时会指认一个根本没跑过的模型，只能当兜底。
    modelId: getStringPayloadField(payload.details, 'model') ?? context?.modelId,
    provider: getStringPayloadField(payload.details, 'provider'),
    timestamp: Date.now(),
  };
  const explicitStatus = getNumberPayloadField(payload, 'httpStatus')
    ?? getNumberPayloadField(payload, 'statusCode')
    ?? getNumberPayloadField(payload, 'status');

  if (payload.code === 'CONTEXT_LENGTH_EXCEEDED') {
    const details = payload.details;
    return {
      ...base,
      category: 'context_length',
      httpStatus: explicitStatus,
      requestedTokens: getNumberPayloadField(details, 'requested'),
      maxTokens: getNumberPayloadField(details, 'max'),
    };
  }

  if (isGenericRunFailure(payload)) {
    const normalized = message.trim().toLowerCase();
    const hasStatus = (status: number) => new RegExp(`\\b${status}\\b`).test(message);

    if (normalized.includes('concurrency limit exceeded')) {
      return { ...base, category: 'concurrency', httpStatus: explicitStatus };
    }

    if (normalized === 'forbidden' || normalized === 'ai_apicallerror: forbidden' || hasStatus(403)) {
      return { ...base, category: 'forbidden', httpStatus: explicitStatus ?? 403 };
    }

    if (normalized === 'not found' || normalized === 'ai_apicallerror: not found' || hasStatus(404)) {
      return { ...base, category: 'model_not_found', httpStatus: explicitStatus ?? 404 };
    }

    if (normalized.includes('rate limit') || normalized.includes('too many requests') || hasStatus(429)) {
      return { ...base, category: 'rate_limited', httpStatus: explicitStatus ?? 429 };
    }

    if (
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('network') ||
      normalized.includes('fetch failed') ||
      normalized.includes('econnrefused') ||
      normalized.includes('econnreset') ||
      normalized.includes('enotfound')
    ) {
      return { ...base, category: 'network', httpStatus: explicitStatus };
    }
  }

  return { ...base, category: 'generic', httpStatus: explicitStatus };
}

/**
 * 把结构化错误挂到最后一条 assistant 消息的 metadata 上（AgentErrorCard 渲染源）。
 * 错误若发生在任何 assistant 草稿之前（如首轮请求直接 404），补一条空 assistant
 * 消息承载卡片——否则这次失败在会话区完全不可见。
 */
function attachAgentErrorToLatestAssistant(agentError: AgentErrorMetadata): void {
  const store = useSessionStore.getState();
  const messages = store.messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant') {
    store.updateMessage(lastMessage.id, {
      metadata: { ...lastMessage.metadata, agentError },
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

function removeUncommittedAssistantDraft(
  messages: Message[],
  draftMessageId: string | null | undefined,
): Message[] {
  if (!draftMessageId) return messages;
  const draft = messages.find((message) => message.id === draftMessageId);
  if (draft?.role !== 'assistant') return messages;
  if ((draft.toolCalls?.length || 0) > 0) return messages;
  return messages.filter((message) => message.id !== draftMessageId);
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
          if (event.data && (!event.data.toolCalls || event.data.toolCalls.length === 0)) {
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
          clearSessionProcessing();
          refreshContextHealth();
          break;

        case 'agent_complete':
        case 'agent_cancelled':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
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
