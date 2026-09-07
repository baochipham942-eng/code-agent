import type { Message } from '@shared/contract';
import type { MessageMetadata } from '@shared/contract/message';
import { useSessionStore } from '../stores/sessionStore';

export function userMessageReplacement(
  existing: Message,
  incoming: Pick<Message, 'content' | 'attachments' | 'metadata'>,
): Pick<Message, 'content' | 'attachments' | 'metadata'> {
  const nextMetadata = { ...existing.metadata, ...incoming.metadata };
  delete nextMetadata.sendFailed;
  return {
    content: incoming.content,
    attachments: incoming.attachments,
    metadata: nextMetadata,
  };
}

/** 同 id 已在时间线上：替换正文/附件并清 sendFailed。没有这条则 false。 */
export function replaceOptimisticUserMessage(
  userMessage: Pick<Message, 'id' | 'content' | 'attachments' | 'metadata'>,
): boolean {
  const store = useSessionStore.getState();
  const existing = store.messages.find((message) => message.id === userMessage.id);
  if (existing?.role !== 'user') return false;
  store.updateMessage(userMessage.id, userMessageReplacement(existing, userMessage));
  return true;
}

/** 同 clientMessageId 替换重发：更新原文/附件并清掉失败态；没有这条就当新乐观气泡。 */
export function upsertOptimisticUserMessage(
  userMessage: Message,
  addMessage: (message: Message) => void,
): boolean {
  if (replaceOptimisticUserMessage(userMessage)) return false;
  addMessage(userMessage);
  return true;
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
