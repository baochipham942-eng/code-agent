import type { Message } from '@shared/contract';
import type { MessageMetadata } from '@shared/contract/message';
import { useSessionStore } from '../stores/sessionStore';

/** 同 clientMessageId 替换重发：更新原文/附件并清掉失败态；没有这条就当新乐观气泡。 */
export function upsertOptimisticUserMessage(
  userMessage: Message,
  addMessage: (message: Message) => void,
): boolean {
  const existing = useSessionStore.getState().messages.find(
    (message) => message.id === userMessage.id,
  );
  if (!existing) {
    addMessage(userMessage);
    return true;
  }
  const nextMetadata = { ...existing.metadata, ...userMessage.metadata };
  delete nextMetadata.sendFailed;
  useSessionStore.getState().updateMessage(userMessage.id, {
    content: userMessage.content,
    attachments: userMessage.attachments,
    metadata: nextMetadata,
  });
  return false;
}

export function markOptimisticUserSendFailed(messageId: string): void {
  const store = useSessionStore.getState();
  const existing = store.messages.find((message) => message.id === messageId);
  if (!existing) return;
  store.updateMessage(messageId, {
    metadata: { ...existing.metadata, sendFailed: true },
  });
}

export function buildSendFailureRetryAnchor(
  userMessage: Message,
  sessionId?: string | null,
): MessageMetadata | undefined {
  if (!userMessage.content?.trim() && !userMessage.attachments?.length) return undefined;
  return {
    retryPrompt: userMessage.content ?? '',
    retryClientMessageId: userMessage.id,
    ...(userMessage.attachments?.length ? { retryAttachments: userMessage.attachments } : {}),
    ...(sessionId ? { retrySessionId: sessionId } : {}),
  };
}
