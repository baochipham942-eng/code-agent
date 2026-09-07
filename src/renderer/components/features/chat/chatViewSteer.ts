import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_DOMAINS } from '@shared/ipc';
import { generateMessageId } from '@shared/utils/id';
import { getAgentSendFailureMessage } from '../../../hooks/agent/useAgentIPC';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  markOptimisticUserSendFailed,
  replaceOptimisticUserMessage,
} from '../../../utils/optimisticUserSend';

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
  const inCurrentSession = steerEnvelope.sessionId === sessionState.currentSessionId;
  const optimisticUser = {
    id: clientMessageId,
    role: 'user' as const,
    content: steerEnvelope.content,
    attachments: steerEnvelope.attachments,
    timestamp: Date.now(),
    metadata: steerEnvelope.context?.runtimeInput
      ? { workbench: { runtimeInputMode: steerEnvelope.context.runtimeInput.mode } }
      : undefined,
  };
  const replacedExisting = inCurrentSession && replaceOptimisticUserMessage(optimisticUser);
  const addedOptimisticMessage = inCurrentSession && !replacedExisting;
  if (addedOptimisticMessage) {
    useSessionStore.getState().addMessage(optimisticUser);
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
    else if (replacedExisting) markOptimisticUserSendFailed(clientMessageId);
    useSessionStore.getState().addMessage({
      id: generateMessageId(),
      role: 'assistant',
      content: getAgentSendFailureMessage(error),
      timestamp: Date.now(),
    });
    return undefined;
  }
}
