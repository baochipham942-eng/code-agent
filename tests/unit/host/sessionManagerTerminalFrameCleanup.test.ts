import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import {
  getTerminalFrameDirectory,
  persistTerminalFrame,
  readTerminalFrame,
} from '../../../src/host/services/surfaceExecution/TerminalFrameStore';

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

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * 会话删除收敛点的帧清理接线：删掉 sessionManager.deleteSession 里
 * deleteTerminalFrames 那行调用，本测试必须变红（变异验证 #1）。
 */
describe('SessionManager.deleteSession 终态留影帧清理', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-terminal-frames-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;

    coreDb = new DatabaseService();
    coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    coreConnection.pragma('journal_mode = WAL');
    applySchema(coreConnection, logger as never);
    applySessionsMigrations(coreConnection, logger as never);
    Object.assign(coreDb as unknown as Record<string, unknown>, {
      db: coreConnection,
      sessionRepo: new SessionRepository(coreConnection),
    });
    vi.spyOn(coreDb, 'logAuditEvent').mockImplementation(() => undefined);
    coreDatabase.current = coreDb;
    sessionManager = new SessionManager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sessionManager?.dispose();
    coreDatabase.current = null;
    try { coreDb.close(); } catch { /* noop */ }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSession(sessionId: string): void {
    coreDb.createSessionWithId(sessionId, {
      title: sessionId,
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
  }

  it('删会话后该会话的盘上留影帧被清掉，别的会话不受影响', async () => {
    createSession('session-a');
    createSession('session-b');
    await persistTerminalFrame({ conversationId: 'session-a', surfaceSessionId: 'surface-1' }, JPEG_BYTES);
    await persistTerminalFrame({ conversationId: 'session-b', surfaceSessionId: 'surface-1' }, JPEG_BYTES);
    expect(fs.existsSync(getTerminalFrameDirectory('session-a'))).toBe(true);

    await sessionManager.deleteSession('session-a');

    expect(fs.existsSync(getTerminalFrameDirectory('session-a'))).toBe(false);
    expect(await readTerminalFrame({ conversationId: 'session-a', surfaceSessionId: 'surface-1' })).toBeNull();
    expect(await readTerminalFrame({ conversationId: 'session-b', surfaceSessionId: 'surface-1' })).toEqual(JPEG_BYTES);
  });

  it('会话没有留影帧时删除照常成功（幂等，不报错）', async () => {
    createSession('session-no-frames');
    await expect(sessionManager.deleteSession('session-no-frames')).resolves.toBeUndefined();
  });
});
