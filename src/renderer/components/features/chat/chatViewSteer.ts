import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_DOMAINS } from '@shared/ipc';
import { generateMessageId } from '@shared/utils/id';
import { getAgentSendFailureMessage } from '../../../hooks/agent/useAgentIPC';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';

function removeOptimisticMessage(messageId: string): void {
  const store = useSessionStore.getState();
  store.setMessages(store.messages.filter((message) => message.id !== messageId));
}

export async function submitSteerEnvelope(
  envelope: ConversationEnvelope,
  currentSessionId: string | null,
  expectedTurnId?: string,
): Promise<SteerOrQueueOutcome | undefined> {
  const clientMessageId = envelope.clientMessageId ?? generateMessageId();
  const steerEnvelope: ConversationEnvelope = {
    ...envelope,
    clientMessageId,
    sessionId: envelope.sessionId ?? currentSessionId ?? undefined,
    expectedTurnId,
  };

  const sessionState = useSessionStore.getState();
  const addedOptimisticMessage = steerEnvelope.sessionId === sessionState.currentSessionId
    && !sessionState.messages.some((message) => message.id === clientMessageId);
  if (addedOptimisticMessage) {
    useSessionStore.getState().addMessage({
      id: clientMessageId,
      role: 'user',
      content: steerEnvelope.content,
      attachments: steerEnvelope.attachments,
      timestamp: Date.now(),
      metadata: steerEnvelope.context?.runtimeInput
        ? { workbench: { runtimeInputMode: steerEnvelope.context.runtimeInput.mode } }
        : undefined,
    });
  }

  try {
    const outcome = await ipcService.invokeDomain<SteerOrQueueOutcome>(
      IPC_DOMAINS.AGENT,
      'interrupt',
      steerEnvelope,
    );
    if (outcome.outcome === 'queued' && addedOptimisticMessage) {
      removeOptimisticMessage(clientMessageId);
    }
    return outcome;
  } catch (error) {
    if (addedOptimisticMessage) removeOptimisticMessage(clientMessageId);
    useSessionStore.getState().addMessage({
      id: generateMessageId(),
      role: 'assistant',
      content: getAgentSendFailureMessage(error),
      timestamp: Date.now(),
    });
    return undefined;
  }
}
