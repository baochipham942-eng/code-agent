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
      // source 是 Message 顶层字段而非 metadata 的子字段（MessageMetadata 无 source）
      source: 'automation',
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

  it('DB 句柄存在但未初始化时自愈初始化后持久化（打包态 webServer 派发轮 assistant 蒸发 P0 复现）', async () => {
    const manager = new CLISessionManager();
    const message: Message = {
      id: 'message-selfinit',
      role: 'assistant',
      content: '派发轮回复',
      timestamp: 789,
    };

    const addMessage = vi.fn();
    const fakeDb = {
      isInitialized: false,
      initialize: vi.fn(async () => {
        fakeDb.isInitialized = true;
      }),
      addMessage,
    };
    Object.assign(manager as unknown as Record<string, unknown>, {
      _dbChecked: true,
      _db: fakeDb,
    });

    await manager.addMessageToSession('session-selfinit', message);

    expect(fakeDb.initialize).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledWith('session-selfinit', message);
  });

  it('自愈初始化失败时不抛出且不写库（内存模式兜底）', async () => {
    const manager = new CLISessionManager();
    const addMessage = vi.fn();
    const fakeDb = {
      isInitialized: false,
      initialize: vi.fn(async () => {
        throw new Error('disk unavailable');
      }),
      addMessage,
    };
    Object.assign(manager as unknown as Record<string, unknown>, {
      _dbChecked: true,
      _db: fakeDb,
    });

    await expect(manager.addMessageToSession('session-initfail', {
      id: 'message-initfail',
      role: 'assistant',
      content: 'x',
      timestamp: 1,
    })).resolves.toBeUndefined();

    expect(addMessage).not.toHaveBeenCalled();
  });

  it('getMessages 在未初始化句柄上同样自愈（loopPersistedAssistant 判定依赖）', async () => {
    const manager = new CLISessionManager();
    const stored: Message[] = [{ id: 'm1', role: 'assistant', content: 'ok', timestamp: 2 }];
    const fakeDb = {
      isInitialized: false,
      initialize: vi.fn(async () => {
        fakeDb.isInitialized = true;
      }),
      getMessages: vi.fn(() => stored),
    };
    Object.assign(manager as unknown as Record<string, unknown>, {
      _dbChecked: true,
      _db: fakeDb,
    });

    await expect(manager.getMessages('session-read')).resolves.toEqual(stored);
    expect(fakeDb.initialize).toHaveBeenCalledTimes(1);
  });
});
