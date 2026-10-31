// ============================================================================
// useAssistantFeedbackEvents — 「正在思考」反馈态的 agent 事件订阅
// ----------------------------------------------------------------------------
// 从 ChatView 原样搬出（N-EXTHISTORY-IMPORT-CHATS-RESUME 让位给导入会话续聊的
// 发送包装，保持 ChatView 净行数不涨）：把 QUEUED_INPUT_ACTIVATED 与 agent:event
// 的关键帧折进 pendingAssistantFeedback 状态机，纯订阅、无业务分支。
// ============================================================================

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { AgentEventEnvelope } from '@shared/contract';
import type { QueuedInputActivatedEvent } from '@shared/contract/queuedInput';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import {
  transitionAssistantFeedback,
  type AssistantFeedbackState,
} from '../../../utils/sendWithImmediateAssistantFeedback';

export function useAssistantFeedbackEvents(
  setPendingAssistantFeedback: Dispatch<SetStateAction<AssistantFeedbackState | null>>,
): void {
  useEffect(() => {
    const unsubscribeActivated = ipcService.on(
      IPC_CHANNELS.QUEUED_INPUT_ACTIVATED,
      (activation: QueuedInputActivatedEvent) => {
        setPendingAssistantFeedback((current) => transitionAssistantFeedback(current, {
          type: 'durable_activated',
          clientMessageId: activation.id,
          sessionId: activation.sessionId,
        }));
      },
    );
    const unsubscribeAgentEvent = ipcService.on('agent:event', (event: AgentEventEnvelope) => {
      const eventType: string = event.type;
      const eventSessionId = event.sessionId
        ?? (event.data && typeof event.data === 'object' && 'sessionId' in event.data
          ? String(event.data.sessionId)
          : undefined);
      if (!eventSessionId) return;
      if (eventType === 'task_start') {
        const clientMessageId = event.data && typeof event.data === 'object'
          && 'clientMessageId' in event.data && typeof event.data.clientMessageId === 'string'
          ? event.data.clientMessageId
          : undefined;
        if (!clientMessageId) return;
        setPendingAssistantFeedback((current) => transitionAssistantFeedback(current, {
          type: 'durable_activated',
          clientMessageId,
          sessionId: eventSessionId,
        }));
        return;
      }
      if (eventType === 'message_delta') {
        setPendingAssistantFeedback((current) => transitionAssistantFeedback(current, {
          type: 'model_delta',
          sessionId: eventSessionId,
        }));
        return;
      }
      if (eventType === 'error' || eventType === 'agent_cancelled' || eventType === 'stream_end' || eventType === 'agent_complete') {
        setPendingAssistantFeedback((current) => transitionAssistantFeedback(current, {
          type: eventType === 'agent_complete' ? 'run_finished' : 'send_failed',
          sessionId: eventSessionId,
        }));
      }
    });
    return () => {
      unsubscribeActivated?.();
      unsubscribeAgentEvent?.();
    };
  }, []);
}
