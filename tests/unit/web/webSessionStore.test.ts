import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import {
  setDbAvailable,
} from '../../../src/web/helpers/sessionCache';
import {
  createWebSessionStore,
  deleteSessionProjection,
  getSessionMessageCount,
  getSessionMessagesProjection,
  getSessionProjection,
  listSessionProjections,
  replaceSessionMessagesProjection,
  inMemorySessionsProjection as inMemorySessions,
  sessionMessagesProjection as sessionMessages,
  setSessionArchivedProjection,
  upsertSessionProjection,
} from '../../../src/web/helpers/webSessionStore';

function createDatabaseStub() {
  return {
    getSession: vi.fn<() => { id: string; title: string } | null>(() => null),
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

  it.each([
    { dbIsAvailable: false, label: 'memory-primary' },
    { dbIsAvailable: true, label: 'database-backed projection' },
  ])('owns session and message projection access in $label mode', ({ dbIsAvailable }) => {
    setDbAvailable(dbIsAvailable);
    upsertSessionProjection({
      id: 'projection-active',
      title: 'Active',
      createdAt: 1,
      updatedAt: 20,
      messageCount: 0,
    });
    upsertSessionProjection({
      id: 'projection-archived',
      title: 'Archived',
      createdAt: 2,
      updatedAt: 30,
      messageCount: 0,
      isArchived: true,
    });
    replaceSessionMessagesProjection('projection-active', [{
      id: 'projection-message',
      role: 'user',
      content: 'projection content',
      timestamp: 3,
    }]);

    expect(listSessionProjections(false).map((session) => session.id)).toEqual(['projection-active']);
    expect(listSessionProjections(true).map((session) => session.id)).toEqual([
      'projection-archived',
      'projection-active',
    ]);
    expect(getSessionProjection('projection-active')?.title).toBe('Active');
    expect(getSessionMessagesProjection('projection-active')?.[0]?.id).toBe('projection-message');
    expect(getSessionMessageCount('projection-active')).toBe(1);
    expect(setSessionArchivedProjection('projection-active', true)).toMatchObject({
      id: 'projection-active',
      isArchived: true,
      archivedAt: expect.any(Number),
    });

    deleteSessionProjection('projection-active');

    expect(getSessionProjection('projection-active')).toBeUndefined();
    expect(getSessionMessagesProjection('projection-active')).toBeUndefined();
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

  it('loadSessionHistoryForRun falls back to infra when CLI SessionManager is not persistent', async () => {
    const cliGetMessages = vi.fn(async () => [] as Message[]);
    const isPersistent = vi.fn(async () => false);
    const infraGetMessages = vi.fn(async () => [
      { id: 'infra-user', role: 'user', content: '上一轮', timestamp: 1 },
      { id: 'infra-assistant', role: 'assistant', content: '回答', timestamp: 2 },
    ] as Message[]);
    const store = createWebSessionStore({
      tryGetSessionManager: async () => ({
        getMessages: cliGetMessages,
        isPersistent,
      }),
      tryGetInfraSessionManager: async () => ({ getMessages: infraGetMessages }),
      logger,
      getDatabase: vi.fn(),
    });

    const history = await store.loadSessionHistoryForRun('session-infra-fallback');

    expect(isPersistent).toHaveBeenCalledTimes(1);
    expect(cliGetMessages).not.toHaveBeenCalled();
    expect(infraGetMessages).toHaveBeenCalledWith('session-infra-fallback');
    expect(history.map((message) => message.id)).toEqual(['infra-user', 'infra-assistant']);
    expect(sessionMessages.get('session-infra-fallback')).toEqual(history);
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
    expect(db.updateMessage).toHaveBeenCalledWith('duplicate-user', message, 'session-duplicate');
  });

  it('direct core fallback surfaces a cross-session duplicate guard miss', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.addMessage.mockImplementationOnce(() => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.id');
    });
    db.updateMessage.mockImplementationOnce(() => {
      throw new Error('Message update missed for session session-core-b and id forced-core-collision');
    });
    const store = createWebSessionStore({
      tryGetSessionManager: async () => null,
      logger,
      getDatabase: async () => db as unknown as DatabaseService,
    });

    const persisted = await store.prePersistUserMessage({
      sessionId: 'session-core-b',
      title: 'core B',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      message: {
        id: 'forced-core-collision',
        role: 'user',
        content: 'core B',
        timestamp: 20,
      },
    });

    expect(persisted).toBe(false);
    expect(db.updateMessage).toHaveBeenCalledWith(
      'forced-core-collision',
      expect.objectContaining({ content: 'core B' }),
      'session-core-b',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Pre-persist user message to DB failed (continuing run):',
      'Message update missed for session session-core-b and id forced-core-collision',
    );
  });

  it('commitTurn persists through the shared DB fallback when SessionManager is unavailable', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-no-sm', title: 'Existing' });
    db.addMessage.mockImplementationOnce(() => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.id');
    });
    const tryGetSessionManager = vi.fn(async () => null);
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });

    const result = await store.commitTurn({
      sessionId: 'session-no-sm',
      title: '无 SessionManager',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 1,
      userMessagePrePersistedDb: false,
      userMessage: {
        id: 'duplicate-user',
        role: 'user',
        content: '仍需落库',
        timestamp: 20,
      },
      turn: {
        assistantText: '兜底回答',
        assistantThinking: '',
        assistantMetadata: undefined,
        assistantToolCalls: [],
        lastLoopAssistantMessageId: undefined,
        contentParts: [{ type: 'text', text: '兜底回答' }],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => false,
      },
    });

    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledTimes(2);
    expect(db.updateMessage).toHaveBeenCalledWith(
      'duplicate-user',
      expect.objectContaining({ id: 'duplicate-user', role: 'user', content: '仍需落库' }),
      'session-no-sm',
    );
    expect(db.addMessage).toHaveBeenLastCalledWith(
      'session-no-sm',
      expect.objectContaining({ id: result.assistantMsgId, role: 'assistant', content: '兜底回答' }),
    );
    expect(db.updateSession).toHaveBeenCalledWith('session-no-sm', { updatedAt: expect.any(Number) });
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Failed to persist messages to DB:',
      expect.any(String),
    );
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

    expect(result.assistantMsgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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

  it('commitTurn replaces the DB-mode cache with the persisted message projection', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-db', title: 'Existing' });
    const addMessageToSession = vi.fn(async () => undefined);
    const persistedMessages = [
      {
        id: 'user-db',
        role: 'user',
        content: '数据库中的用户消息',
        timestamp: 30,
      },
      {
        id: 'tool-db',
        role: 'tool',
        content: '工具结果',
        timestamp: 31,
      },
      {
        id: 'loop-final',
        role: 'assistant',
        content: '数据库中的最终回答',
        timestamp: 32,
        thinking: '数据库中的思考',
        metadata: { source: 'loop' },
      },
    ] as Message[];
    const getMessages = vi.fn(async () => persistedMessages);
    const tryGetSessionManager = vi.fn(async () => ({ addMessageToSession, getMessages }));
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });
    sessionMessages.set('session-db', [{
      id: 'stale-cache-message',
      role: 'assistant',
      content: '旧缓存内容',
      timestamp: 1,
    }]);

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
    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(addMessageToSession).not.toHaveBeenCalled();
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(db.updateSession).toHaveBeenCalledWith('session-db', { updatedAt: expect.any(Number) });
    expect(sessionMessages.get('session-db')).toEqual([
      {
        id: 'user-db',
        role: 'user',
        content: '数据库中的用户消息',
        timestamp: 30,
        toolCalls: undefined,
        thinking: undefined,
        contentParts: undefined,
        artifacts: undefined,
        attachments: undefined,
        metadata: undefined,
      },
      {
        id: 'loop-final',
        role: 'assistant',
        content: '数据库中的最终回答',
        timestamp: 32,
        toolCalls: undefined,
        thinking: '数据库中的思考',
        contentParts: undefined,
        artifacts: undefined,
        attachments: undefined,
        metadata: { source: 'loop' },
      },
    ]);
  });

  it('commitTurn falls back to the collector projection when the DB read-back fails', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-readback-failure', title: 'Existing' });
    const addMessageToSession = vi.fn(async () => undefined);
    const readbackError = new Error('read-back unavailable');
    const getMessages = vi.fn(async () => {
      throw readbackError;
    });
    const tryGetSessionManager = vi.fn(async () => ({ addMessageToSession, getMessages }));
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });
    sessionMessages.set('session-readback-failure', [{
      id: 'existing-user',
      role: 'user',
      content: '上一轮',
      timestamp: 1,
    }]);

    const result = await store.commitTurn({
      sessionId: 'session-readback-failure',
      title: '读回失败',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 1,
      userMessagePrePersistedDb: false,
      userMessage: {
        id: 'fallback-user',
        role: 'user',
        content: '本轮问题',
        timestamp: 40,
      },
      turn: {
        assistantText: 'collector 回答',
        assistantThinking: 'collector 思考',
        assistantMetadata: undefined,
        assistantToolCalls: [],
        lastLoopAssistantMessageId: undefined,
        contentParts: [{ type: 'text', text: 'collector 回答' }],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => false,
      },
    });

    expect(addMessageToSession).toHaveBeenCalledTimes(2);
    expect(getMessages).toHaveBeenCalledWith('session-readback-failure');
    expect(logger.warn).toHaveBeenCalledWith(
      '[AgentRouter] Failed to refresh session cache from persisted messages for session-readback-failure:',
      readbackError,
    );
    expect(sessionMessages.get('session-readback-failure')).toEqual([
      expect.objectContaining({ id: 'existing-user', role: 'user', content: '上一轮' }),
      expect.objectContaining({ id: 'fallback-user', role: 'user', content: '本轮问题' }),
      expect.objectContaining({
        id: result.assistantMsgId,
        role: 'assistant',
        content: 'collector 回答',
        thinking: 'collector 思考',
      }),
    ]);
  });

  it.each([
    'ensure session',
    'user write',
    'assistant write',
    'session update',
  ] as const)('commitTurn warns and falls back without throwing when %s fails', async (failureStage) => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-persist-failure', title: 'Existing' });
    const persistenceError = new Error(`${failureStage} failed`);
    const readbackError = new Error('read-back unavailable after persistence failure');
    const addMessageToSession = vi.fn(async () => undefined);
    const getMessages = vi.fn(async () => {
      throw readbackError;
    });

    if (failureStage === 'ensure session') {
      db.getSession.mockImplementationOnce(() => {
        throw persistenceError;
      });
    } else if (failureStage === 'user write' || failureStage === 'assistant write') {
      addMessageToSession.mockRejectedValueOnce(persistenceError);
    } else {
      db.updateSession.mockImplementationOnce(() => {
        throw persistenceError;
      });
    }

    const tryGetSessionManager = vi.fn(async () => ({ addMessageToSession, getMessages }));
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });
    sessionMessages.set('session-persist-failure', [{
      id: 'existing-user',
      role: 'user',
      content: '上一轮',
      timestamp: 1,
    }]);

    const result = await store.commitTurn({
      sessionId: 'session-persist-failure',
      title: '持久化失败',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 1,
      userMessagePrePersistedDb: failureStage !== 'user write',
      userMessage: {
        id: 'failure-user',
        role: 'user',
        content: '本轮问题',
        timestamp: 40,
      },
      turn: {
        assistantText: 'collector 回答',
        assistantThinking: 'collector 思考',
        assistantMetadata: undefined,
        assistantToolCalls: [],
        lastLoopAssistantMessageId: undefined,
        contentParts: [{ type: 'text', text: 'collector 回答' }],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => false,
      },
    });

    expect(result).toEqual({
      assistantMsgId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to persist messages to DB:',
      persistenceError.message,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[AgentRouter] Failed to refresh session cache from persisted messages for session-persist-failure:',
      readbackError,
    );
    expect(sessionMessages.get('session-persist-failure')).toEqual([
      expect.objectContaining({ id: 'existing-user', role: 'user', content: '上一轮' }),
      expect.objectContaining({ id: 'failure-user', role: 'user', content: '本轮问题' }),
      expect.objectContaining({ role: 'assistant', content: 'collector 回答', thinking: 'collector 思考' }),
    ]);
  });

  it('commitTurn treats a dedup read failure as not persisted and keeps the route alive', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-dedup-failure', title: 'Existing' });
    const dedupError = new Error('dedup read unavailable');
    const readbackError = new Error('projection read unavailable');
    const addMessageToSession = vi.fn(async () => undefined);
    const getMessages = vi.fn()
      .mockRejectedValueOnce(dedupError)
      .mockRejectedValueOnce(readbackError);
    const tryGetSessionManager = vi.fn(async () => ({ addMessageToSession, getMessages }));
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });

    const result = await store.commitTurn({
      sessionId: 'session-dedup-failure',
      title: '去重读取失败',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 1,
      userMessagePrePersistedDb: true,
      userMessage: {
        id: 'dedup-user',
        role: 'user',
        content: '本轮问题',
        timestamp: 40,
      },
      turn: {
        assistantText: '仍需兜底写入',
        assistantThinking: '',
        assistantMetadata: undefined,
        assistantToolCalls: [],
        lastLoopAssistantMessageId: 'loop-final',
        contentParts: [{ type: 'text', text: '仍需兜底写入' }],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => false,
      },
    });

    expect(result).toEqual({
      assistantMsgId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[AgentRouter] Failed to verify loop-persisted assistant messages for session-dedup-failure:',
      dedupError,
    );
    expect(addMessageToSession).toHaveBeenCalledWith(
      'session-dedup-failure',
      expect.objectContaining({ id: result.assistantMsgId, role: 'assistant', content: '仍需兜底写入' }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Failed to persist messages to DB:',
      expect.any(String),
    );
  });

  it('commitTurn keeps the user message in the DB-mode cache for a tool-only turn', async () => {
    setDbAvailable(true);
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-db-tool-only', title: 'Existing' });
    const persistedMessages = [{
      id: 'tool-only-user',
      role: 'user',
      content: '只调用工具',
      timestamp: 50,
    }] as Message[];
    const getMessages = vi.fn(async () => persistedMessages);
    const tryGetSessionManager = vi.fn(async () => ({
      addMessageToSession: vi.fn(async () => undefined),
      getMessages,
    }));
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const store = createWebSessionStore({ tryGetSessionManager, logger, getDatabase });

    await store.commitTurn({
      sessionId: 'session-db-tool-only',
      title: '只调用工具',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      historyLength: 0,
      userMessagePrePersistedDb: true,
      userMessage: {
        id: 'tool-only-user',
        role: 'user',
        content: '只调用工具',
        timestamp: 50,
      },
      turn: {
        assistantText: '',
        assistantThinking: '',
        assistantMetadata: undefined,
        assistantToolCalls: [{ id: 'tool-only-call', name: 'Read' }],
        lastLoopAssistantMessageId: undefined,
        contentParts: [{ type: 'tool_call', toolCallId: 'tool-only-call' }],
        runCancelled: false,
        hasAssistantOutput: () => true,
        hasInterleaving: () => false,
      },
    });

    expect(getMessages).toHaveBeenCalledWith('session-db-tool-only');
    expect(sessionMessages.get('session-db-tool-only')).toEqual([
      expect.objectContaining({
        id: 'tool-only-user',
        role: 'user',
        content: '只调用工具',
      }),
    ]);
  });
});
