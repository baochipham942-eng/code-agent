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
import { createWebSessionStore } from '../../../src/web/helpers/webSessionStore';

const coreDatabase = vi.hoisted(() => ({ current: null as DatabaseService | null }));
const cacheLifecycle = vi.hoisted(() => ({ clearSessionRuntimeCaches: vi.fn() }));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => {
    if (!coreDatabase.current) throw new Error('core database unavailable');
    return coreDatabase.current;
  },
}));

const authUser = vi.hoisted(() => ({ current: { id: 'user-signed-in' } as { id: string } | null }));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => authUser.current }),
}));

vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));

vi.mock('../../../src/host/session/sessionCacheLifecycle', () => cacheLifecycle);
vi.mock('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', () => ({
  getManagedBrowserProviderAdapter: () => ({
    clearConversationResumeState: vi.fn(async () => undefined),
  }),
}));

import { SessionManager } from '../../../src/host/services/infra/sessionManager';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('/api/run 新会话行的归属与 owner 过滤写入（N-RUN-CONCURRENT-PERSIST-FAIL）', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let cliDb: CLIDatabaseService;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let cliSessionManager: CLISessionManager;
  let infraSessionManager: SessionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    authUser.current = { id: 'user-signed-in' };
    setDbAvailable(true);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-store-owner-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;

    cliDb = new CLIDatabaseService();
    await cliDb.initialize();
    cliSessionManager = new CLISessionManager();
    Object.assign(cliSessionManager as unknown as Record<string, unknown>, { _db: cliDb, _dbChecked: true });

    coreDb = new DatabaseService();
    coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    coreConnection.pragma('journal_mode = WAL');
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

  function newStore() {
    return createWebSessionStore({
      tryGetSessionManager: async () => cliSessionManager,
      tryGetInfraSessionManager: async () => infraSessionManager,
      logger,
      getDatabase: vi.fn(async () => coreDb),
    });
  }

  function msg(id: string, role: Message['role'], i: number): Message {
    return { id, role, content: `${role} ${i}`, timestamp: 1_700_000_000_000 + i };
  }

  it('已登录时 pre-persist 建的新会话归当前用户，多个会话并发经 infra SM 写几十条消息全部落库', async () => {
    const store = newStore();
    const ids = Array.from({ length: 12 }, (_, i) => `run-session-${i}`);
    for (const [i, sessionId] of ids.entries()) {
      expect(await store.prePersistUserMessage({
        sessionId,
        title: `run ${i}`,
        modelConfig: { provider: 'zhipu', model: 'glm-5' },
        message: msg(`${sessionId}-user`, 'user', i),
      })).toBe(true);
    }

    // orchestrator / delegate_task 后台任务走的就是这条 owner 过滤写入
    const results = await Promise.allSettled(ids.flatMap((sessionId, i) =>
      [1, 2, 3, 4, 5].map((n) => infraSessionManager.addMessageToSession(
        sessionId,
        msg(`${sessionId}-m${n}`, n % 2 ? 'assistant' : 'user', i * 10 + n),
      ))));

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const sessionId of ids) {
      expect(coreDb.getSession(sessionId, { userId: 'user-signed-in' })).not.toBeNull();
    }
    const stored = coreConnection.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id LIKE ?').get('run-session-%') as { n: number };
    expect(stored.n).toBe(12 * 6);
  });

  it('fail-closed 不变：归属别人或根本不存在的会话，infra SM 写入仍然抛 not found', async () => {
    const store = newStore();
    await store.prePersistUserMessage({
      sessionId: 'owned-by-me',
      title: 't',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
      message: msg('owned-by-me-user', 'user', 1),
    });

    authUser.current = { id: 'someone-else' };
    await expect(infraSessionManager.addMessageToSession('owned-by-me', msg('x1', 'assistant', 2)))
      .rejects.toThrow('Session owned-by-me not found');
    await expect(infraSessionManager.addMessageToSession('never-created', msg('x2', 'assistant', 3)))
      .rejects.toThrow('Session never-created not found');
  });
});
