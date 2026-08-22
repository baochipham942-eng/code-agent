import type { SteerOrQueueOutcome } from '@shared/contract/appService';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_DOMAINS } from '@shared/ipc';
import { generateMessageId } from '@shared/utils/id';
import { getAgentSendFailureMessage } from '../../../hooks/agent/useAgentIPC';
import ipcService from '../../../services/ipcService';
import { useSessionStore } from '../../../stores/sessionStore';

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

  try {
    const outcome = await ipcService.invokeDomain<SteerOrQueueOutcome>(
      IPC_DOMAINS.AGENT,
      'interrupt',
      steerEnvelope,
    );
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
