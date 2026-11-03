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
import { getToolScreenshotDir } from '../../../src/host/tools/utils/toolScreenshotDir';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/**
 * 会话删除收敛点的工具截图目录回收接线（N-RETENTION-APP-CACHES-REST1）：
 * 删掉 sessionManager.deleteSession / cleanupDeletedSession 里的
 * removeToolScreenshotDir 调用，本测试必须变红（变异验证）。
 */
describe('SessionManager.deleteSession 工具截图目录回收', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tool-shots-'));
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

  /** 造一个带截图文件的会话截图目录，返回其路径 */
  function makeScreenshotDir(sessionId: string): string {
    const dir = getToolScreenshotDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'screenshot_1.png'), 'x');
    return dir;
  }

  it('deleteSession 后该会话的工具截图目录被清掉，别的会话不受影响', async () => {
    createSession('session-a');
    createSession('session-b');
    const dirA = makeScreenshotDir('session-a');
    const dirB = makeScreenshotDir('session-b');

    await sessionManager.deleteSession('session-a');

    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(true);
  });

  it('截图目录删除失败（只读 EACCES）不拖挂 deleteSession：会话照常删成、目录留着', async () => {
    createSession('session-locked');
    const dir = makeScreenshotDir('session-locked');
    fs.chmodSync(dir, 0o555);
    try {
      await expect(sessionManager.deleteSession('session-locked')).resolves.toBeUndefined();
      expect(coreDb.getSession('session-locked')).toBeFalsy();
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('cleanupDeletedSession（companion 收尾路径）同样回收该会话的截图目录', async () => {
    // 会话行本就不存在（tombstone 已写）：只验目录回收这一段
    const dir = makeScreenshotDir('session-gone');

    await sessionManager.cleanupDeletedSession('session-gone');

    expect(fs.existsSync(dir)).toBe(false);
  });

  /**
   * Rework r1 回归：会话分叉把父会话消息整行复制到子会话名下
   * （SessionForkRepository：content/tool_results/content_parts 原样带绝对路径），
   * 子会话在父删除后仍存活（parentDeleted）。删父会话时：
   *   - 被子会话引用的截图必须保留（活引用）；
   *   - 只被父会话自己引用/无人引用的照删（死者引用不算数，tombstone 不删消息行）。
   */
  it('分叉子会话引用了父会话截图路径时，删父会话保留被引用文件、只清无活引用的文件', async () => {
    createSession('parent-a');
    createSession('child-fork');
    const dir = getToolScreenshotDir('parent-a');
    fs.mkdirSync(dir, { recursive: true });
    const referencedByChild = path.join(dir, 'screenshot_1800000000000.png');
    const referencedByParentOnly = path.join(dir, 'screenshot_1800000000001.png');
    const unreferenced = path.join(dir, 'screenshot_1800000000002.png');
    fs.writeFileSync(referencedByChild, 'x');
    fs.writeFileSync(referencedByParentOnly, 'x');
    fs.writeFileSync(unreferenced, 'x');
    const insertMessage = coreConnection.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
    );
    // 子会话复制来的父阶段消息：content 带父截图绝对路径（活引用，父删后仍要用）
    insertMessage.run('m-child-1', 'child-fork', 'assistant', `已保存截图 ${referencedByChild}`, 1800000000000);
    // 父会话自己的消息也引用另一张（死者引用，不应保）
    insertMessage.run('m-parent-1', 'parent-a', 'assistant', `已保存截图 ${referencedByParentOnly}`, 1800000000000);

    await sessionManager.deleteSession('parent-a');

    expect(fs.existsSync(referencedByChild)).toBe(true);
    expect(fs.existsSync(referencedByParentOnly)).toBe(false);
    expect(fs.existsSync(unreferenced)).toBe(false);
  });
});
