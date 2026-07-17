import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { Message } from '../../../src/shared/contract';
import { CLIDatabaseService } from '../../../src/cli/database';
import { CLISessionManager } from '../../../src/cli/session';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';
import {
  createWebSessionStore,
  getSessionMessagesProjection,
} from '../../../src/web/helpers/webSessionStore';

const coreDatabase = vi.hoisted(() => ({ current: null as DatabaseService | null }));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => {
    if (!coreDatabase.current) throw new Error('core database unavailable');
    return coreDatabase.current;
  },
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));

import { SessionManager } from '../../../src/host/services/infra/sessionManager';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createCommitInput(sessionId: string) {
  return {
    sessionId,
    title: 'CLI 统一写入',
    modelConfig: { provider: 'zhipu' as const, model: 'glm-5' },
    historyLength: 1,
    userMessagePrePersistedDb: true,
    userMessage: {
      id: 'user-rich',
      role: 'user' as const,
      content: '请读取工作区',
      timestamp: 1_700_000_000_000,
    },
    turn: {
      assistantText: [
        '已读取。',
        '',
        '```chart',
        '{"title":"Files","data":[1]}',
        '```',
      ].join('\n'),
      assistantThinking: '确认文件内容',
      // MessageMetadata 无自由文本 source 字段，借 workbench.workingDirectory 承载
      // 一个可辨识的标记值，验证 metadata 原样落库/读回。
      assistantMetadata: { workbench: { workingDirectory: 'web-store' } },
      assistantToolCalls: [{ id: 'call-read', name: 'Read', arguments: { path: 'src' } }],
      lastLoopAssistantMessageId: undefined,
      contentParts: [
        { type: 'text' as const, text: '已读取。' },
        { type: 'tool_call' as const, toolCallId: 'call-read' },
      ],
      runCancelled: false,
      hasAssistantOutput: () => true,
      hasInterleaving: () => true,
    },
  };
}

describe('WebSessionStore CLI SessionManager backend', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let cliDb: CLIDatabaseService;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let cliSessionManager: CLISessionManager;
  let infraSessionManager: SessionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    setDbAvailable(true);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-store-cli-sm-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;

    cliDb = new CLIDatabaseService();
    await cliDb.initialize();
    cliSessionManager = new CLISessionManager();
    Object.assign(cliSessionManager as unknown as Record<string, unknown>, {
      _db: cliDb,
      _dbChecked: true,
    });

    coreDb = new DatabaseService();
    coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    coreConnection.pragma('journal_mode = WAL');
    // 本地 logger 只 mock debug/info/warn/error 四个被测路径用到的方法；
    // applySchema/applySessionsMigrations 要求完整的服务 Logger（含 level/setLevel/log/dispose）。
    applySchema(coreConnection, logger as never);
    applySessionsMigrations(coreConnection, logger as never);
    Object.assign(coreDb as unknown as Record<string, unknown>, {
      db: coreConnection,
      sessionRepo: new SessionRepository(coreConnection),
    });
    coreDatabase.current = coreDb;
    infraSessionManager = new SessionManager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await infraSessionManager?.dispose();
    coreDatabase.current = null;
    try { coreDb.close(); } catch { /* noop */ }
    try { cliDb.close(); } catch { /* noop */ }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setDbAvailable(false, new Error('test reset'));
  });

  it('经 CLI SM 写入后由 infra SM 全字段读回，并失效旧缓存后重算列表快照', async () => {
    const sessionId = 'session-cli-store';
    const richUserMessage: Message = {
      id: 'user-rich',
      role: 'user',
      content: '请读取工作区',
      timestamp: 1_700_000_000_000,
      thinking: '用户侧上下文',
      contentParts: [{ type: 'text', text: '请读取工作区' }],
      attachments: [
        {
          id: 'image-rich',
          type: 'image',
          category: 'image',
          name: 'preview.png',
          size: 24,
          mimeType: 'image/png',
          data: 'data:image/png;base64,c21hbGw=',
          thumbnail: 'data:image/png;base64,dGh1bWI=',
          metadata: { source: 'clipboard' },
        },
        {
          id: 'sheet-rich',
          type: 'file',
          category: 'excel',
          name: 'report.xlsx',
          size: 128,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: 'Sheet1\nA,B\n1,2',
          sheetsJson: '{"Sheet1":[["A","B"],[1,2]]}',
          metadata: { source: 'upload' },
        },
      ],
      // 同上：MessageMetadata 无 source 字段，借 workbench.workingDirectory 承载标记值。
      metadata: { workbench: { workingDirectory: 'web-store-user' } },
    };
    const invalidateSessionCache = vi.spyOn(infraSessionManager, 'invalidateSessionCache');
    const getDatabase = vi.fn(async () => coreDb);
    const store = createWebSessionStore({
      tryGetSessionManager: async () => cliSessionManager,
      tryGetInfraSessionManager: async () => infraSessionManager,
      logger,
      getDatabase,
    });

    expect(await store.prePersistUserMessage({
      sessionId,
      title: 'CLI 统一写入',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
      message: richUserMessage,
    })).toBe(true);

    await infraSessionManager.getSession(sessionId, 30);
    await store.commitTurn(createCommitInput(sessionId));

    expect(invalidateSessionCache).toHaveBeenCalledWith(sessionId);
    expect(getDatabase).not.toHaveBeenCalled();
    const infraMessages = await infraSessionManager.getMessages(sessionId);
    expect(infraMessages).toHaveLength(2);
    expect(infraMessages[0]).toMatchObject({
      id: 'user-rich',
      thinking: '用户侧上下文',
      contentParts: richUserMessage.contentParts,
      attachments: richUserMessage.attachments,
      metadata: richUserMessage.metadata,
    });
    expect(infraMessages[1]).toMatchObject({
      role: 'assistant',
      thinking: '确认文件内容',
      contentParts: createCommitInput(sessionId).turn.contentParts,
      metadata: { workbench: { workingDirectory: 'web-store' } },
      artifacts: [expect.objectContaining({ type: 'chart', title: 'Files' })],
    });

    const listed = await infraSessionManager.listSessions();
    expect(listed[0]?.workbenchSnapshot?.recentToolNames).toEqual(['Read']);
    expect(getSessionMessagesProjection(sessionId)).toEqual([
      expect.objectContaining({ id: 'user-rich', attachments: richUserMessage.attachments }),
      expect.objectContaining({ role: 'assistant', thinking: '确认文件内容' }),
    ]);
  });

  it('infra SM 不可用时不影响 CLI 提交，并记录 debug 降级信息', async () => {
    const sessionId = 'session-no-infra-sm';
    const store = createWebSessionStore({
      tryGetSessionManager: async () => cliSessionManager,
      tryGetInfraSessionManager: async () => null,
      logger,
      getDatabase: async () => coreDb,
    });

    expect(await store.prePersistUserMessage({
      sessionId,
      title: '无 infra SM',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
      message: {
        id: 'user-rich',
        role: 'user',
        content: '继续提交',
        timestamp: 1_700_000_000_000,
      },
    })).toBe(true);

    await expect(store.commitTurn(createCommitInput(sessionId))).resolves.toEqual({
      assistantMsgId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });
    expect(await cliSessionManager.getMessages(sessionId)).toHaveLength(2);
    expect(logger.debug).toHaveBeenCalledWith(
      `[AgentRouter] Infra SessionManager unavailable; skipped cache invalidation for ${sessionId}`,
    );
  });

  it('同毫秒提交两会话时使用全局唯一 assistant id，A/B 内容各自落库', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const store = createWebSessionStore({
      tryGetSessionManager: async () => cliSessionManager,
      tryGetInfraSessionManager: async () => infraSessionManager,
      logger,
      getDatabase: async () => coreDb,
    });
    const inputA = createCommitInput('session-generated-a');
    inputA.turn.assistantText = 'assistant A';
    const inputB = createCommitInput('session-generated-b');
    inputB.turn.assistantText = 'assistant B';

    expect(await store.prePersistUserMessage({
      sessionId: inputA.sessionId,
      title: inputA.title,
      modelConfig: inputA.modelConfig,
      message: { id: 'generated-user-a', role: 'user', content: 'user A', timestamp: 1 },
    })).toBe(true);
    expect(await store.prePersistUserMessage({
      sessionId: inputB.sessionId,
      title: inputB.title,
      modelConfig: inputB.modelConfig,
      message: { id: 'generated-user-b', role: 'user', content: 'user B', timestamp: 2 },
    })).toBe(true);

    const resultA = await store.commitTurn(inputA);
    const resultB = await store.commitTurn(inputB);

    expect(resultA.assistantMsgId).not.toBe(resultB.assistantMsgId);
    expect(await cliSessionManager.getMessages('session-generated-a')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'generated-user-a', content: 'user A' }),
      expect.objectContaining({ id: resultA.assistantMsgId, content: 'assistant A' }),
    ]));
    expect(await cliSessionManager.getMessages('session-generated-b')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'generated-user-b', content: 'user B' }),
      expect.objectContaining({ id: resultB.assistantMsgId, content: 'assistant B' }),
    ]));
  });

  it('CLI manager 对跨会话重复 id fail-loud，且保留合法同会话幂等更新', async () => {
    const messageId = 'forced-cli-collision';
    const options = {
      title: 'collision',
      modelConfig: { provider: 'zhipu' as const, model: 'glm-5' },
    };
    await cliSessionManager.addMessageToSession('session-cli-a', {
      id: messageId,
      role: 'assistant',
      content: 'CLI A v1',
      timestamp: 1,
    }, options);
    await cliSessionManager.addMessageToSession('session-cli-a', {
      id: messageId,
      role: 'assistant',
      content: 'CLI A v2',
      timestamp: 2,
    });

    await expect(cliSessionManager.addMessageToSession('session-cli-b', {
      id: messageId,
      role: 'assistant',
      content: 'CLI B',
      timestamp: 3,
    }, options)).rejects.toThrow(/message update missed.*session-cli-b.*forced-cli-collision/i);

    expect(await cliSessionManager.getMessages('session-cli-a')).toEqual([
      expect.objectContaining({ id: messageId, content: 'CLI A v2' }),
    ]);
    expect(await cliSessionManager.getMessages('session-cli-b')).toEqual([]);
  });

  it('infra manager 对跨会话重复 id fail-loud，不覆写原会话', async () => {
    const messageId = 'forced-infra-collision';
    coreDb.createSessionWithId('session-infra-a', {
      title: 'infra A',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
    coreDb.createSessionWithId('session-infra-b', {
      title: 'infra B',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
    await infraSessionManager.addMessageToSession('session-infra-a', {
      id: messageId,
      role: 'assistant',
      content: 'infra A',
      timestamp: 1,
    });

    await expect(infraSessionManager.addMessageToSession('session-infra-b', {
      id: messageId,
      role: 'assistant',
      content: 'infra B',
      timestamp: 2,
    })).rejects.toThrow(/message update missed.*session-infra-b.*forced-infra-collision/i);

    expect(await infraSessionManager.getMessages('session-infra-a')).toEqual([
      expect.objectContaining({ id: messageId, content: 'infra A' }),
    ]);
    expect(await infraSessionManager.getMessages('session-infra-b')).toEqual([]);
  });
});
