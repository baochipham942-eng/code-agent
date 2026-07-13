import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import {
  inMemorySessions,
  sessionMessages,
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';
import { createWebSessionStore } from '../../../src/web/helpers/webSessionStore';

function createDatabaseStub() {
  return {
    getSession: vi.fn(() => null),
    createSessionWithId: vi.fn(),
    updateSession: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    getMessages: vi.fn(() => []),
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('WebSessionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMessages.clear();
    inMemorySessions.clear();
    setDbAvailable(false, new Error('test reset'));
  });

  afterEach(() => {
    sessionMessages.clear();
    inMemorySessions.clear();
    setDbAvailable(false, new Error('test reset'));
  });

  it('loadSessionHistoryForRun hydrates a cold cache from SessionManager', async () => {
    const getMessages = vi.fn(async () => [
      { id: 'user-1', role: 'user', content: '上一轮', timestamp: 1 },
      { id: 'tool-1', role: 'tool', content: '工具结果', timestamp: 2 },
      { id: 'assistant-1', role: 'assistant', content: '回答', timestamp: 3 },
    ] as Message[]);
    const tryGetSessionManager = vi.fn(async () => ({ getMessages }));
    const getDatabase = vi.fn();
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });

    const history = await store.loadSessionHistoryForRun('session-cold');

    expect(tryGetSessionManager).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith('session-cold');
    expect(getDatabase).not.toHaveBeenCalled();
    expect(history.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(sessionMessages.get('session-cold')).toEqual(history);
  });

  it('prePersistUserMessage updates a duplicate id through the direct DB fallback', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.addMessage.mockImplementationOnce(() => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.id');
    });
    const tryGetSessionManager = vi.fn(async () => null);
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });
    const message = {
      id: 'duplicate-user',
      role: 'user',
      content: '重复消息',
      timestamp: 10,
    } as Message;

    const persisted = await store.prePersistUserMessage({
      sessionId: 'session-duplicate',
      title: '重复消息',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      message,
    });

    expect(persisted).toBe(true);
    expect(tryGetSessionManager).toHaveBeenCalledTimes(1);
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(db.createSessionWithId).toHaveBeenCalledWith('session-duplicate', {
      title: '重复消息',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    });
    expect(db.updateMessage).toHaveBeenCalledWith('duplicate-user', message);
  });

  it('commitTurn keeps the SSE-backed rich cache, metadata and memory-session projection', async () => {
    const tryGetSessionManager = vi.fn();
    const getDatabase = vi.fn();
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });
    for (let index = 0; index < 50; index += 1) {
      sessionMessages.set(`session-${index}`, [{
        id: `message-${index}`,
        role: 'user',
        content: `cached-${index}`,
        timestamp: index,
      }]);
    }
    const metadata = {
      turnQuality: {
        capabilities: { agentId: 'explore', agentName: 'Explorer' },
      },
    } as Message['metadata'];

    const result = await store.commitTurn({
      sessionId: 'session-memory',
      title: '内存轮次',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 0,
      userMessagePrePersistedDb: false,
      userMessage: {
        id: 'user-memory',
        role: 'user',
        content: '内存轮次',
        timestamp: 20,
      },
      turn: {
        assistantText: '```chart\n{"title":"Memory","data":[]}\n```',
        assistantThinking: '思考',
        assistantMetadata: metadata,
        assistantToolCalls: [{ id: 'tool-memory', name: 'Read' }],
        lastLoopAssistantMessageId: 'loop-memory-final',
        contentParts: [
          { type: 'text', text: '图表' },
          { type: 'tool_call', toolCallId: 'tool-memory' },
        ],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => true,
      },
    });

    expect(result.assistantMsgId).toMatch(/^msg-\d+-a$/);
    expect(sessionMessages.get('session-memory')).toEqual([
      expect.objectContaining({ id: 'user-memory', role: 'user' }),
      expect.objectContaining({
        id: result.assistantMsgId,
        role: 'assistant',
        thinking: '思考',
        metadata,
        contentParts: [
          { type: 'text', text: '图表' },
          { type: 'tool_call', toolCallId: 'tool-memory' },
        ],
        artifacts: [expect.objectContaining({ type: 'chart', title: 'Memory' })],
      }),
    ]);
    expect(inMemorySessions.get('session-memory')).toMatchObject({
      id: 'session-memory',
      title: '内存轮次',
      messageCount: 2,
    });
    expect(sessionMessages.size).toBe(50);
    expect(sessionMessages.has('session-0')).toBe(false);
    expect(tryGetSessionManager).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('commitTurn preserves the final-loop dedup guard and per-segment dependency calls', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-db', title: 'Existing' });
    const addMessageToSession = vi.fn(async () => undefined);
    const getMessages = vi.fn(async () => [{
      id: 'loop-final',
      role: 'assistant',
      content: 'loop 已落库',
      timestamp: 30,
    }] as Message[]);
    const tryGetSessionManager = vi.fn(async () => ({ addMessageToSession, getMessages }));
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });

    await store.commitTurn({
      sessionId: 'session-db',
      title: '数据库轮次',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 1,
      userMessagePrePersistedDb: true,
      userMessage: {
        id: 'user-db',
        role: 'user',
        content: '数据库轮次',
        timestamp: 40,
      },
      turn: {
        assistantText: '最终回答',
        assistantThinking: '',
        assistantMetadata: undefined,
        assistantToolCalls: [],
        lastLoopAssistantMessageId: 'loop-final',
        contentParts: [{ type: 'text', text: '最终回答' }],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => false,
      },
    });

    expect(tryGetSessionManager).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(addMessageToSession).not.toHaveBeenCalled();
    expect(getDatabase).toHaveBeenCalledTimes(2);
    expect(db.updateSession).toHaveBeenCalledWith('session-db', { updatedAt: expect.any(Number) });
  });
});
