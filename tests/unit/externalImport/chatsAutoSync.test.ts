// chatsAutoSync：门控矩阵 / 单飞 / 真 sqlite 两轮增量（N-EXTHISTORY-IMPORT-SYNC-CHATS 验收②⑤）
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const env = vi.hoisted(() => ({
  importRecentChats: vi.fn(async (_req: unknown): Promise<unknown[]> => []),
  database: null as unknown,
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({ createLogger: () => logger }));
vi.mock('../../../src/host/services/agentEngine/agentEngineHistoryImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/agentEngine/agentEngineHistoryImport')>()),
  getAgentEngineHistoryImportService: () => ({ importRecentChats: env.importRecentChats }),
}));
vi.mock('../../../src/host/services/sessionFork/ownerScope', () => ({
  currentSessionForkOwnerScopeId: () => 'neo.local-owner',
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => env.database }));
vi.mock('../../../src/host/services/git/gitStatusService', () => ({ getProjectSourceGitStates: vi.fn() }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ invalidateSessionCache: () => {} }),
}));

import {
  getChatsSyncState,
  importRecentChatsSingleFlight,
  runChatsAutoSync,
  setChatsSyncMode,
  startChatsAutoSync,
} from '../../../src/host/externalImport/chatsAutoSync';
import { readChatsSyncState, writeChatsSyncState } from '../../../src/host/externalImport/chatsSyncPreference';
import { SessionHistoryAppService } from '../../../src/host/app/sessionHistoryAppService';
import { importRecentExternalChats } from '../../../src/host/externalImport/chatsImport';
import { AgentEngineHistoryImportService } from '../../../src/host/services/agentEngine/agentEngineHistoryImport';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionForkPortabilitySchema } from '../../../src/host/services/core/database/schemaSessionForkPortability';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { SessionForkPortabilityRepository } from '../../../src/host/services/core/repositories/SessionForkPortabilityRepository';
import { ProjectService } from '../../../src/host/services/project/projectService';
import type { TaskManager } from '../../../src/host/task/TaskManager';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const tempDirs: string[] = [];
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-autosync-data-'));
  tempDirs.push(dataDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  env.importRecentChats.mockReset();
  env.importRecentChats.mockResolvedValue([]);
  logger.warn.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('runChatsAutoSync 门控矩阵', () => {
  it.each(['off', 'paused'] as const)('%s：零次导入、零次广播', async (mode) => {
    writeChatsSyncState({ mode });
    const onImported = vi.fn();
    await runChatsAutoSync({ onImported });
    expect(env.importRecentChats).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('缺文件（默认 off）：零次导入', async () => {
    await runChatsAutoSync();
    expect(env.importRecentChats).not.toHaveBeenCalled();
  });

  it('on：导入一次，带 owner scope；imported>0 才广播并记 lastRun', async () => {
    writeChatsSyncState({ mode: 'on' });
    env.importRecentChats.mockResolvedValue([
      { engine: 'claude_code', sourceSessionId: 'a', title: 'a', status: 'imported' },
      { engine: 'codex_cli', sourceSessionId: 'b', title: 'b', status: 'already_imported' },
    ]);
    const onImported = vi.fn();
    await runChatsAutoSync({ onImported, now: () => 777 });
    expect(env.importRecentChats).toHaveBeenCalledTimes(1);
    expect(env.importRecentChats).toHaveBeenCalledWith({ ownerScopeId: 'neo.local-owner' });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(readChatsSyncState()).toEqual({ mode: 'on', lastRun: { at: 777, imported: 1 } });
  });

  it('on 但全是 already_imported：不广播', async () => {
    writeChatsSyncState({ mode: 'on' });
    env.importRecentChats.mockResolvedValue([
      { engine: 'claude_code', sourceSessionId: 'a', title: 'a', status: 'already_imported' },
    ]);
    const onImported = vi.fn();
    await runChatsAutoSync({ onImported });
    expect(onImported).not.toHaveBeenCalled();
  });

  it('导入抛错：吞掉并 warn 出原因，不广播', async () => {
    writeChatsSyncState({ mode: 'on' });
    env.importRecentChats.mockRejectedValue(new Error('disk exploded'));
    const onImported = vi.fn();
    await expect(runChatsAutoSync({ onImported })).resolves.toBeUndefined();
    expect(onImported).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'disk exploded' });
  });

  it('startChatsAutoSync 注册的监听在导入后被调用', async () => {
    writeChatsSyncState({ mode: 'on' });
    env.importRecentChats.mockResolvedValue([{ engine: 'claude_code', sourceSessionId: 'a', title: 'a', status: 'imported' }]);
    const listener = vi.fn();
    await startChatsAutoSync(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('同步进行中切换模式（rework r2）', () => {
  it.each(['off', 'paused'] as const)('同步进行中切到 %s：写回不得把 mode 拨回 on，lastRun 照记、广播照发', async (mode) => {
    writeChatsSyncState({ mode: 'on' });
    let release!: (value: unknown[]) => void;
    env.importRecentChats.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const onImported = vi.fn();
    const sync = runChatsAutoSync({ onImported, now: () => 888 });
    // 导入仍在进行时用户关/暂停开关（走真实用户路径 setChatsSyncMode，不直写文件）
    await setChatsSyncMode(mode);
    expect(readChatsSyncState().mode).toBe(mode);
    release([{ engine: 'claude_code', sourceSessionId: 'a', title: 'a', status: 'imported' }]);
    await sync;
    expect(readChatsSyncState()).toEqual({ mode, lastRun: { at: 888, imported: 1 } });
    // 导入已经发生，会话列表仍要刷新
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});

describe('setChatsSyncMode', () => {
  it('off -> on 先同步一轮再返回含 lastRun 的状态；on -> paused / off 不导入', async () => {
    env.importRecentChats.mockResolvedValue([{ engine: 'claude_code', sourceSessionId: 'a', title: 'a', status: 'imported' }]);
    const state = await setChatsSyncMode('on', { now: () => 5 });
    expect(env.importRecentChats).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ mode: 'on', lastRun: { at: 5, imported: 1 } });

    expect(await setChatsSyncMode('paused')).toMatchObject({ mode: 'paused' });
    expect(await setChatsSyncMode('off')).toMatchObject({ mode: 'off' });
    expect(env.importRecentChats).toHaveBeenCalledTimes(1);
    expect(getChatsSyncState().mode).toBe('off');
  });
});

describe('单飞（验收⑤）', () => {
  it('同步进行中手动导入 await 同一 promise：只调一次底层导入', async () => {
    writeChatsSyncState({ mode: 'on' });
    let release!: (value: unknown[]) => void;
    env.importRecentChats.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sync = runChatsAutoSync();
    const manual = importRecentChatsSingleFlight();
    const manual2 = importRecentChatsSingleFlight();
    expect(manual2).toBe(manual);
    release([]);
    await Promise.all([sync, manual]);
    expect(env.importRecentChats).toHaveBeenCalledTimes(1);
    // 结束后 guard 释放，下一次是新一轮
    await importRecentChatsSingleFlight();
    expect(env.importRecentChats).toHaveBeenCalledTimes(2);
  });
});

describe('真 sqlite：两轮之间新增的会话恰好导入一次，旧的保持', () => {
  let db: BetterSqlite3.Database;
  let claudeRoot: string;

  const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<typeof applySchema>[1];

  async function writeChat(sessionId: string, timestamp: string): Promise<void> {
    const file = path.join(claudeRoot, sessionId, `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const user = { type: 'user', uuid: `u-${sessionId}`, sessionId, timestamp, message: { content: [{ type: 'text', text: `hello ${sessionId}` }] } };
    const assistant = {
      type: 'assistant', uuid: `a-${sessionId}`, sessionId,
      timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(),
      message: { content: [{ type: 'text', text: 'ok' }] },
    };
    await fs.writeFile(file, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
  }

  const sessionCount = () => (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;

  beforeEach(async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-autosync-db-'));
    tempDirs.push(dbDir);
    db = new Database(path.join(dbDir, 'code-agent.db'));
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    applySessionForkPortabilitySchema(db);
    const portabilityRepo = new SessionForkPortabilityRepository(db);
    const projectRepo = new ProjectRepository(db);
    const projectService = new ProjectService(() => projectRepo);
    env.database = {
      importSessionFork: (input: unknown) => portabilityRepo.importSessionFork(input as never),
      getProjectRepo: () => projectRepo,
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-autosync-src-'));
    tempDirs.push(root);
    claudeRoot = path.join(root, 'claude');
    const codexRoot = path.join(root, 'codex');
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.mkdir(codexRoot, { recursive: true });
    const historyService = new AgentEngineHistoryImportService({ roots: { claudeProjectsRoot: claudeRoot, codexSessionsRoot: codexRoot } });
    env.importRecentChats.mockImplementation((req: unknown) => importRecentExternalChats({
      ...(req as { ownerScopeId: string }),
      now: () => NOW,
      historyService,
      resolveProject: (cwd, now) => projectService.ensureProjectForWorkspace(cwd, now),
      lookupProjectForWorkspace: (cwd) => Promise.resolve(projectService.findProjectForWorkspace(cwd)),
      hasExistingImport: (query) => portabilityRepo.hasImportedExport(query.sourceExportId, query.ownerScopeId, query.projectId, query.namespace),
      importFork: (input) => new SessionHistoryAppService(() => null as unknown as TaskManager).importSessionFork({
        envelope: input.envelope, targetProjectId: input.targetProjectId, namespace: input.namespace,
      }),
    }));
  });

  afterEach(() => { db.close(); });

  it('第一轮导入 A；源里加 B 后第二轮只多 B；关掉后加 C 不导入', async () => {
    writeChatsSyncState({ mode: 'on' });
    const onImported = vi.fn();
    await writeChat('chat-a', '2026-10-20T10:00:00.000Z');
    await runChatsAutoSync({ onImported });
    expect(sessionCount()).toBe(1);
    expect(onImported).toHaveBeenCalledTimes(1);

    await writeChat('chat-b', '2026-10-21T10:00:00.000Z');
    await runChatsAutoSync({ onImported });
    expect(sessionCount()).toBe(2);
    expect(onImported).toHaveBeenCalledTimes(2);

    // 无新内容：不重复、不广播
    await runChatsAutoSync({ onImported });
    expect(sessionCount()).toBe(2);
    expect(onImported).toHaveBeenCalledTimes(2);

    await setChatsSyncMode('off');
    await writeChat('chat-c', '2026-10-22T10:00:00.000Z');
    await runChatsAutoSync({ onImported });
    expect(sessionCount()).toBe(2);
  });
});
