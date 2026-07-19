import type { Message } from '@shared/contract';
import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_DOMAINS } from '@shared/ipc';
import { generateMessageId } from '@shared/utils/id';
import { getAgentSendFailureMessage, toMessageMetadata } from '../../../hooks/agent/useAgentIPC';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';

export async function submitSteerEnvelope(
  envelope: ConversationEnvelope,
  currentSessionId: string | null,
  onQueued: () => Promise<void>,
): Promise<SteerOrQueueOutcome | undefined> {
  const clientMessageId = envelope.clientMessageId ?? generateMessageId();
  const steerEnvelope: ConversationEnvelope = {
    ...envelope,
    clientMessageId,
    sessionId: envelope.sessionId ?? currentSessionId ?? undefined,
  };

  try {
    const outcome = await ipcService.invokeDomain<SteerOrQueueOutcome>(
      IPC_DOMAINS.AGENT,
      'interrupt',
      steerEnvelope,
    );
    if (outcome.outcome === 'steered') {
      const userMessage: Message = {
        id: clientMessageId,
        role: 'user',
        content: steerEnvelope.content,
        attachments: steerEnvelope.attachments,
        timestamp: Date.now(),
        metadata: toMessageMetadata(steerEnvelope.context),
      };
      useSessionStore.getState().addMessage(userMessage);
    } else {
      await onQueued();
    }
    return outcome;
  } catch (error) {
    useSessionStore.getState().addMessage({
      id: generateMessageId(),
      role: 'assistant',
      content: getAgentSendFailureMessage(error),
      timestamp: Date.now(),
    });
    return undefined;
  }
}
