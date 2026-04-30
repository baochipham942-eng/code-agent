import { describe, expect, it } from 'vitest';
import { CLISessionManager, type SessionWithMessages } from '../../../src/cli/session';
import type { Message } from '../../../src/shared/contract';

describe('CLISessionManager.addMessageToSession', () => {
  it('keeps cached messageCount aligned when database persistence is unavailable', async () => {
    const manager = new CLISessionManager();
    const sessionId = 'cached-session-1';
    const message: Message = {
      id: 'message-1',
      role: 'assistant',
      content: 'hello',
      timestamp: 123,
    };

    const cache = Reflect.get(manager, 'sessionCache') as Map<string, SessionWithMessages>;
    cache.set(sessionId, {
      id: sessionId,
      title: 'Cached Session',
      modelConfig: { provider: 'openai', model: 'test-model' },
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      todos: [],
      messageCount: 0,
    });

    await manager.addMessageToSession(sessionId, message);

    const cached = cache.get(sessionId);
    expect(cached).toBeDefined();
    if (!cached) throw new Error('Expected cached session');
    expect(cached.messages).toEqual([message]);
    expect(cached.messageCount).toBe(1);
  });
});
