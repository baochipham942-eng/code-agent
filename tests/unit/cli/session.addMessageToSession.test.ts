import { describe, expect, it, vi } from 'vitest';
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

  it('重复消息 id 通过 CLI DB 更新为最新完整内容', async () => {
    const manager = new CLISessionManager();
    const message: Message = {
      id: 'message-duplicate',
      role: 'assistant',
      content: '最新内容',
      timestamp: 456,
      thinking: '最新思考',
      metadata: { source: 'web-store' },
    };
    const updateMessage = vi.fn();
    Object.assign(manager as unknown as Record<string, unknown>, {
      _dbChecked: true,
      _db: {
        isInitialized: true,
        addMessage: vi.fn(() => {
          throw new Error('UNIQUE constraint failed: messages.id');
        }),
        updateMessage,
      },
    });

    await manager.addMessageToSession('session-duplicate', message);

    expect(updateMessage).toHaveBeenCalledWith('message-duplicate', message);
  });
});
