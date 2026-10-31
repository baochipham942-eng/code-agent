// ============================================================================
// undoImport 单测（N-EXTHISTORY-IMPORT-SYNC-UNDO）—— 整批撤销一条导入历史
// ============================================================================
//
// 真 sqlite + 真临时技能目录：聊天软删（台账行数不变）、技能目录删除；
// 有 fork 子会话的聊天 / 被改过的技能保留并写明原因；二次调用幂等；
// 无引用的旧条目抛清晰错误；撤销后同源再导入报 already_imported。

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const bridge = vi.hoisted(() => ({
  database: null as unknown,
  sessionRepo: null as unknown,
  currentUser: null as { id: string } | null,
}));
const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: loggerMocks.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => bridge.currentUser }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => bridge.database,
}));
vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: vi.fn(),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    invalidateSessionCache: () => {},
    deleteSession: async (id: string) => (bridge.sessionRepo as SessionRepository).deleteSession(id),
  }),
}));
vi.mock('../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({ refreshClaudeLegacySkillsInclusion: vi.fn() }),
}));

import { SessionHistoryAppService } from '../../../src/host/app/sessionHistoryAppService';
import { importRecentExternalChats } from '../../../src/host/externalImport/chatsImport';
import {
  listImportHistory,
  recordChatImportHistory,
  recordSkillsImportHistory,
} from '../../../src/host/externalImport/importHistory';
import { applyExternalSkillsImport } from '../../../src/host/externalImport/skillsImport';
import { ImportUndoError, undoImportHistoryEntry } from '../../../src/host/externalImport/undoImport';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionForkPortabilitySchema } from '../../../src/host/services/core/database/schemaSessionForkPortability';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { SessionForkPortabilityRepository } from '../../../src/host/services/core/repositories/SessionForkPortabilityRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ProjectService } from '../../../src/host/services/project/projectService';
import type { TaskManager } from '../../../src/host/task/TaskManager';
import { LOCAL_SESSION_FORK_OWNER_SCOPE_ID } from '../../../src/shared/contract/sessionForkPortability';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<typeof applySchema>[1];

let tmpRoot: string;
let db: BetterSqlite3.Database;
let portabilityRepo: SessionForkPortabilityRepository;
let projectService: ProjectService;
let claudeRoot: string;
let homeDir: string;
let userSkillsDir: string;

async function writeClaudeChat(sessionId: string): Promise<string> {
  const file = path.join(claudeRoot, sessionId, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [
    { type: 'user', uuid: `u-${sessionId}`, sessionId, timestamp: '2026-10-10T10:00:00.000Z', message: { content: [{ type: 'text', text: `hello ${sessionId}` }] } },
    { type: 'assistant', uuid: `a-${sessionId}`, sessionId, timestamp: '2026-10-10T10:00:01.000Z', message: { content: [{ type: 'text', text: 'ok' }] } },
  ];
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

function runImport(options?: { now?: () => number; ownerScopeId?: string }) {
  return importRecentExternalChats({
    ownerScopeId: options?.ownerScopeId ?? LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
    now: options?.now ?? (() => NOW),
    roots: { claudeProjectsRoot: claudeRoot, codexSessionsRoot: path.join(tmpRoot, 'codex-none') },
    resolveProject: (cwd, now) => projectService.ensureProjectForWorkspace(cwd, now),
    lookupProjectForWorkspace: (cwd) => Promise.resolve(projectService.findProjectForWorkspace(cwd)),
    hasExistingImport: (query) => portabilityRepo.hasImportedExport(
      query.sourceExportId, query.ownerScopeId, query.projectId, query.namespace,
    ),
    importFork: (input) => new SessionHistoryAppService(() => null as unknown as TaskManager).importSessionFork({
      envelope: input.envelope,
      targetProjectId: input.targetProjectId,
      namespace: input.namespace,
    }),
  });
}

function sessionRow(id: string): { is_deleted: number } {
  return db.prepare('SELECT is_deleted FROM sessions WHERE id = ?').get(id) as { is_deleted: number };
}

function importedRoot(sourceSessionId: string): string {
  return portabilityRepo.findImportedRootSessionId(`external-history:claude_code:${sourceSessionId}`) as string;
}

function ledgerCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM session_fork_portability_imports').get() as { c: number }).c;
}

function ledgerCreatedAt(importedRootSessionId: string): number {
  const row = db.prepare(
    'SELECT created_at FROM session_fork_portability_imports WHERE imported_root_session_id = ?',
  ).get(importedRootSessionId) as { created_at: number };
  return row.created_at;
}

/** 给导入会话挂一个未删除的 fork 子会话（用户在只读会话里「继续」）。 */
function addForkChild(rootId: string): void {
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
    VALUES ('child-of-root', 'native child', 'openai', 'gpt-test', 1, 1)`).run();
  db.prepare(`
    INSERT INTO session_forks (
      id, source_session_id, child_session_id, root_session_id, parent_fork_id,
      anchor_message_id, anchor_child_message_id, workspace_mode, context_delivery_mode,
      idempotency_key, request_digest, source_prefix_digest, status, depth, sync_state,
      workspace_snapshot_id, error_json, created_at, updated_at, committed_at
    ) VALUES ('fork-x', ?, 'child-of-root', ?, NULL, 'a', 'b', 'shared_current', 'validated_context_handoff',
      'k', 'r', 'p', 'completed', 1, 'local_only', NULL, NULL, 1, 1, 1)
  `).run(rootId, rootId);
  db.pragma('foreign_keys = ON');
}

async function writeSkill(dir: string, name: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`);
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

beforeEach(async () => {
  loggerMocks.warn.mockReset();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'undo-import-'));
  claudeRoot = path.join(tmpRoot, 'claude-projects');
  homeDir = path.join(tmpRoot, 'home');
  userSkillsDir = path.join(tmpRoot, 'data', 'skills');
  await fs.mkdir(claudeRoot, { recursive: true });
  await fs.mkdir(path.join(homeDir, '.codex', 'skills'), { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(tmpRoot, 'data'));
  db = new Database(path.join(tmpRoot, 'code-agent.db'));
  applySchema(db, noopLogger);
  applySessionsMigrations(db, noopLogger);
  applyIndexes(db);
  applyConversationBranchSchema(db, { backfillLegacy: false });
  applySessionForkPortabilitySchema(db);
  portabilityRepo = new SessionForkPortabilityRepository(db);
  const projectRepo = new ProjectRepository(db);
  projectService = new ProjectService(() => projectRepo);
  const sessionRepo = new SessionRepository(db);
  bridge.sessionRepo = sessionRepo;
  bridge.database = {
    importSessionFork: (input: unknown) => portabilityRepo.importSessionFork(input as never),
    getProjectRepo: () => projectRepo,
    findSessionForkImportRoot: (id: string, notAfter?: number) => portabilityRepo.findImportedRootSessionId(id, notAfter),
    hasLiveSessionForkChild: (id: string) => portabilityRepo.hasLiveForkChild(id),
    getSession: (id: string) => sessionRepo.getSession(id),
  };
});

afterEach(async () => {
  db.close();
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('undoImportHistoryEntry — chats', () => {
  it('① removes a plain imported chat (is_deleted=1) and leaves the immutable ledger untouched', async () => {
    await writeClaudeChat('plain');
    const results = await runImport();
    await recordChatImportHistory(results);
    const [entry] = await listImportHistory();
    const root = importedRoot('plain');
    const ledgerBefore = ledgerCount();

    const updated = await undoImportHistoryEntry(entry.id);

    expect(sessionRow(root).is_deleted).toBe(1);
    expect(updated.undone).toMatchObject({ removed: 1, kept: [] });
    expect(ledgerCount()).toBe(ledgerBefore);
    expect((await listImportHistory())[0].undone?.removed).toBe(1);
  });

  it('② keeps a chat with a live fork child (continued) while removing the plain one', async () => {
    await writeClaudeChat('plain');
    await writeClaudeChat('continued');
    await recordChatImportHistory(await runImport());
    const [entry] = await listImportHistory();
    addForkChild(importedRoot('continued'));

    const updated = await undoImportHistoryEntry(entry.id);

    expect(sessionRow(importedRoot('plain')).is_deleted).toBe(1);
    expect(sessionRow(importedRoot('continued')).is_deleted).toBe(0);
    expect(updated.undone?.removed).toBe(1);
    expect(updated.undone?.kept).toHaveLength(1);
    expect(updated.undone?.kept[0].reason).toBe('continued');
    expect(loggerMocks.warn).toHaveBeenCalledWith('import undo kept item', expect.objectContaining({ reason: 'continued' }));
  });

  it('③ a second undo is a no-op returning the stored result', async () => {
    await writeClaudeChat('plain');
    await recordChatImportHistory(await runImport());
    const [entry] = await listImportHistory();
    const first = await undoImportHistoryEntry(entry.id);
    const second = await undoImportHistoryEntry(entry.id);
    expect(second.undone).toEqual(first.undone);
  });

  it('④ after undo, importing the same source again reports already_imported (no re-import)', async () => {
    await writeClaudeChat('plain');
    await recordChatImportHistory(await runImport());
    const [entry] = await listImportHistory();
    await undoImportHistoryEntry(entry.id);
    const again = await runImport();
    expect(again.map((r) => [r.sourceSessionId, r.status])).toEqual([['plain', 'already_imported']]);
    expect(sessionRow(importedRoot('plain')).is_deleted).toBe(1);
  });

  it('rework r1: undoing an old entry spares the same chat re-imported later under another owner scope', async () => {
    const chatFile = await writeClaudeChat('plain');
    const first = await runImport();
    expect(first.map((r) => r.status)).toEqual(['imported']);
    // 台账 created_at 走真实时钟，历史条目的 at 也取真实时刻（首次导入之后）。
    const recordedAt = Date.now();
    await recordChatImportHistory(first, { now: () => recordedAt });
    const [entry] = await listImportHistory();
    expect(entry.at).toBe(recordedAt);
    const oldRoot = importedRoot('plain');

    // 同一 exportId 的第二行台账：换 owner scope 后自动同步重导入同一外部聊天
    // （源文件长了消息，payload digest 变了）——去重按 (exportId, owner, project,
    // namespace) 查，owner 不同判未导入，照常落一行。
    await fs.appendFile(chatFile, `${JSON.stringify({ type: 'user', uuid: 'u-plain-2', sessionId: 'plain', timestamp: '2026-10-10T10:00:02.000Z', message: { content: [{ type: 'text', text: 'more' }] } })}\n`);
    bridge.currentUser = { id: 'user-two' };
    const second = await runImport({ ownerScopeId: 'user-two' });
    expect(second.map((r) => r.status)).toEqual(['imported']);
    const newRoot = importedRoot('plain') as string;
    expect(newRoot).not.toBe(oldRoot);
    expect(ledgerCount()).toBe(2);
    expect(ledgerCreatedAt(oldRoot)).toBeLessThanOrEqual(recordedAt);
    expect(ledgerCreatedAt(newRoot)).toBeGreaterThan(recordedAt);
    expect(sessionRow(newRoot).is_deleted).toBe(0);

    const updated = await undoImportHistoryEntry(entry.id);

    expect(sessionRow(oldRoot).is_deleted).toBe(1);
    expect(sessionRow(newRoot).is_deleted).toBe(0);
    expect(updated.undone).toMatchObject({ removed: 1, kept: [] });
  });
});

describe('undoImportHistoryEntry — skills', () => {
  it('① removes a pristine copied skill; ② keeps an edited one with reason edited', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'pristine');
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'edited');
    await applyExternalSkillsImport({ sourceIds: ['codex'] });
    await fs.appendFile(path.join(userSkillsDir, 'edited', 'SKILL.md'), '\nuser edit\n');
    const [entry] = await listImportHistory();

    const updated = await undoImportHistoryEntry(entry.id);

    expect(await exists(path.join(userSkillsDir, 'pristine'))).toBe(false);
    expect(await exists(path.join(userSkillsDir, 'edited'))).toBe(true);
    expect(updated.undone).toMatchObject({ removed: 1, kept: [{ label: 'edited', reason: 'edited' }] });
  });

  it('keeps a skill that is already gone with reason missing', async () => {
    await writeSkill(path.join(homeDir, '.codex', 'skills'), 'gone');
    await applyExternalSkillsImport({ sourceIds: ['codex'] });
    await fs.rm(path.join(userSkillsDir, 'gone'), { recursive: true });
    const [entry] = await listImportHistory();
    const updated = await undoImportHistoryEntry(entry.id);
    expect(updated.undone).toMatchObject({ removed: 0, kept: [{ label: 'gone', reason: 'missing' }] });
  });
});

describe('undoImportHistoryEntry — errors', () => {
  it('③ a legacy entry without refs is not undoable and throws a clear error', async () => {
    await recordSkillsImportHistory([{ sourceId: 'codex', name: 'legacy', action: 'copied' }]);
    const [entry] = await listImportHistory();
    await expect(undoImportHistoryEntry(entry.id)).rejects.toMatchObject({ code: 'NOT_UNDOABLE' });
    await expect(undoImportHistoryEntry('nope')).rejects.toBeInstanceOf(ImportUndoError);
  });
});
