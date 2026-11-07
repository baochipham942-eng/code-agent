import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import {
  SessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../../src/host/task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../../src/host/task/backgroundTaskStore';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import { runStartupSweeps } from '../../../../src/web/startupSweeps';
import type { TaskManager } from '../../../../src/host/task/TaskManager';
import type { Message } from '../../../../src/shared/contract';

const coreDatabase = vi.hoisted(() => ({ current: null as unknown }));
const uiLanguage = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));

vi.mock('../../../../src/host/services/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => {
    if (!coreDatabase.current) throw new Error('core database unavailable');
    return coreDatabase.current;
  },
  getConfigService: () => ({ getSettings: () => ({ ui: { language: uiLanguage.value } }) }),
}));
vi.mock('../../../../src/host/services/core/configService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfigService: () => ({ getSettings: () => ({ ui: { language: uiLanguage.value } }) }),
}));
vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));

import { getSessionManager } from '../../../../src/host/services/infra/sessionManager';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SESSION_ID = 'session-restart-a';

/** startBackgroundTask 永不 settle：模拟宿主在任务运行中被杀。 */
class HangingTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockReturnValue(new Promise(() => undefined));
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents(): () => void { return () => undefined; }
}

describe('指挥台任务：宿主重启后的收口', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let connection: Database.Database;
  const startupLog = { info: vi.fn(), warn: vi.fn() };

  function openDatabase(): void {
    coreDb = new DatabaseService();
    connection = new Database(path.join(tmpDir, 'code-agent.db'));
    connection.pragma('journal_mode = WAL');
    applySchema(connection, logger as never);
    applySessionsMigrations(connection, logger as never);
    Object.assign(coreDb as unknown as Record<string, unknown>, {
      db: connection,
      sessionRepo: new SessionRepository(connection),
    });
    vi.spyOn(coreDb, 'logAuditEvent').mockImplementation(() => undefined);
    coreDatabase.current = coreDb;
  }

  function closeDatabase(): void {
    try { connection.close(); } catch { /* noop */ }
    coreDatabase.current = null;
  }

  /** 「重启」：丢掉所有内存对象，在同一数据目录/DB 文件上重建，然后跑宿主启动收口入口。 */
  async function restartHost(): Promise<void> {
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    getSessionManager().clearCache();
    closeDatabase();
    openDatabase();
    await runStartupSweeps(startupLog);
  }

  async function transcript(): Promise<Message[]> {
    const session = await getSessionManager().getSession(SESSION_ID, 100);
    return (session?.messages ?? []).filter((m) => m.content.startsWith('[任务结果]'));
  }

  async function spawnHangingTask(wake = vi.fn().mockResolvedValue(undefined)): Promise<SessionCommandCenter> {
    const center = new SessionCommandCenter(new HangingTaskManager() as unknown as TaskManager, {
      wakeForegroundBrain: wake,
    });
    const result = await center.spawn({
      sessionId: SESSION_ID,
      title: '后台调研',
      shortName: 'researcher',
      laneKey: 'lane-a',
      submissionKey: 'sub-a',
      prompt: 'do it',
      workspaceScope: createWorkspaceScope('p', [{ sourceId: 's', path: tmpDir, role: 'primary', access: 'read_write' }]),
    });
    expect(result.outcome).toBe('started');
    return center;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-center-restart-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    uiLanguage.value = 'zh';
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    getSessionManager().clearCache();
    openDatabase();
    coreDb.createSessionWithId(SESSION_ID, {
      title: 'restart',
      modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
    getBackgroundTaskLedger().setStore(new SqliteBackgroundTaskStore(connection));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSessionCommandCenterForTest();
    resetBackgroundTaskLedgerForTest();
    getSessionManager().clearCache();
    closeDatabase();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('运行中被重启打断：下次启动在原会话补且只补一条失败消息，第二次启动不再写', async () => {
    await spawnHangingTask();
    expect(await transcript()).toHaveLength(0);

    await restartHost();
    const afterFirst = await transcript();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].content).toContain('researcher｜failed｜');
    expect(afterFirst[0].content).toContain('应用重启');
    expect(afterFirst[0].metadata).toMatchObject({ backgroundTaskResult: { status: 'failed', shortName: 'researcher' } });
    const ledgerTask = getBackgroundTaskLedger().getTask(
      (afterFirst[0].metadata as { backgroundTaskResult: { taskId: string } }).backgroundTaskResult.taskId,
    );
    expect(ledgerTask?.status).toBe('failed');
    expect(ledgerTask?.failure?.reason).toBe('session_command_task_interrupted_by_restart');

    await restartHost();
    expect(await transcript()).toHaveLength(1);
  });

  it('英文界面写英文句子', async () => {
    uiLanguage.value = 'en';
    await spawnHangingTask();
    await restartHost();
    const messages = await transcript();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('restarted');
  });

  it('正常结算的任务不留标记：重启后不会再补消息', async () => {
    const manager = new HangingTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      wakeForegroundBrain: vi.fn().mockResolvedValue(undefined),
    });
    await center.spawn({
      sessionId: SESSION_ID, title: 't', shortName: 'quick', laneKey: 'l', submissionKey: 's', prompt: 'p',
      workspaceScope: createWorkspaceScope('p', [{ sourceId: 's', path: tmpDir, role: 'primary', access: 'read_write' }]),
    });
    const taskId = center.list(SESSION_ID)[0].id;
    manager.emit('task_completed', { type: 'task_completed', sessionId: SESSION_ID, data: { taskId, conclusion: 'ok' } });
    await vi.waitFor(async () => expect(await transcript()).toHaveLength(1));

    await restartHost();
    expect(await transcript()).toHaveLength(1);
  });

  it('唤醒前台失败：会话里仍恰好有一条该任务的 [任务结果]', async () => {
    const wake = vi.fn().mockRejectedValue(new Error('no live owner lease'));
    const manager = new HangingTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, { wakeForegroundBrain: wake });
    await center.spawn({
      sessionId: SESSION_ID, title: 't', shortName: 'wakefail', laneKey: 'l', submissionKey: 's', prompt: 'p',
      workspaceScope: createWorkspaceScope('p', [{ sourceId: 's', path: tmpDir, role: 'primary', access: 'read_write' }]),
    });
    const taskId = center.list(SESSION_ID)[0].id;
    manager.emit('task_completed', { type: 'task_completed', sessionId: SESSION_ID, data: { taskId, conclusion: 'done' } });
    await vi.waitFor(() => expect(wake).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await transcript()).toHaveLength(1));
    const [message] = await transcript();
    expect(message.content).toContain('wakefail｜completed｜');
    expect(message.metadata).toMatchObject({ backgroundTaskResult: { taskId } });
  });
});
