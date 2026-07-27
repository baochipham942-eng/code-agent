import type { Message } from '../../shared/contract';
import type { SessionWithMessages } from '../services';
import type { CachedMessage, CachedSession } from '../session/localCache';

function toCachedMessage(message: Message): CachedMessage {
  const metadata = message.metadata
    ? ({ ...message.metadata } as Record<string, unknown>)
    : undefined;

  return {
    id: message.id,
    role: message.role === 'user' || message.role === 'system' ? message.role : 'assistant',
    content: message.content,
    timestamp: message.timestamp,
    tokens: (message.inputTokens || 0) + (message.outputTokens || 0) || undefined,
    metadata,
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
  };
}

export function toCachedSession(session: SessionWithMessages): CachedSession {
  return {
    sessionId: session.id,
    messages: session.messages.map(toCachedMessage),
    startedAt: session.createdAt,
    lastActivityAt: session.updatedAt,
    totalTokens: session.messages.reduce(
      (sum, message) => sum + (message.inputTokens || 0) + (message.outputTokens || 0),
      0,
    ),
    metadata: {
      ...(session.metadata || {}),
      title: session.title,
      workingDirectory: session.workingDirectory,
    },
  };
}
