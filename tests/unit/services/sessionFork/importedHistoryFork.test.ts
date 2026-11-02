// ============================================================================
// 导入外部历史会话的「发送即分支」持久化契约（N-EXTHISTORY-IMPORT-CHATS-RESUME）
// ----------------------------------------------------------------------------
// 覆盖验收①②：
// ① 导入会话只读——直发走 resolveExternalEngineLaunch 必须抛清晰错误且源行
//    （消息条数 + 内容哈希、engine/model 列）零变化；
// ② 发送即 fork 出新会话、原记录不被改写——真 sqlite 上先 importRecentExternalChats
//    种入含工具调用的 Claude JSONL fixture，再走 SessionForkService（fork 的产品路径）
//    分支：子会话 engine native/manual、模型用注入的应用默认值（不是 claude-history）、
//    lineage/context_delivery_mode=neo_native_prefix、前缀消息照抄。
// ============================================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const dbBridge = vi.hoisted(() => ({
  database: null as unknown,
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbBridge.database,
}));

vi.mock('../../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ invalidateSessionCache: () => {} }),
}));

import { SessionHistoryAppService } from '../../../../src/host/app/sessionHistoryAppService';
import { importRecentExternalChats } from '../../../../src/host/externalImport/chatsImport';
import { AgentEngineHistoryImportService } from '../../../../src/host/services/agentEngine/agentEngineHistoryImport';
import { SessionForkService } from '../../../../src/host/services/sessionFork/SessionForkService';
import { SessionForkRepository } from '../../../../src/host/services/core/repositories/SessionForkRepository';
import { SessionForkPortabilityRepository } from '../../../../src/host/services/core/repositories/SessionForkPortabilityRepository';
import {
  ProjectRepository,
} from '../../../../src/host/services/core/repositories/ProjectRepository';
import { ProjectService } from '../../../../src/host/services/project/projectService';
import { rowToSession } from '../../../../src/host/services/core/repositories/sessionRepositoryParsers';
import {
  resolveExternalEngineLaunch,
} from '../../../../src/host/services/agentEngine/agentEngineGuards';
import { applyIndexes } from '../../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionForkPortabilitySchema } from '../../../../src/host/services/core/database/schemaSessionForkPortability';
import type { TaskManager } from '../../../../src/host/task/TaskManager';
import type { Session } from '../../../../src/shared/contract/session';
import { LOCAL_SESSION_FORK_OWNER_SCOPE_ID } from '../../../../src/shared/contract/sessionForkPortability';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const CODEWORD = 'PINEAPPLE-MOON-4711';
const DEFAULT_MODEL = { provider: 'longcat', model: 'LongCat-2.0' };

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

const tempRoots: string[] = [];

function applyAllSchema(db: BetterSqlite3.Database): void {
  applySchema(db, noopLogger);
  applySessionsMigrations(db, noopLogger);
  applyIndexes(db);
  applyConversationBranchSchema(db, { backfillLegacy: false });
  applySessionForkPortabilitySchema(db);
}

function claudeLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function claudeUserLine(input: { timestamp: string; text: string; cwd?: string }): string {
  return claudeLine({
    type: 'user',
    uuid: `u-${input.timestamp}`,
    sessionId: 'claude-resume-fixture',
    timestamp: input.timestamp,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    message: { content: [{ type: 'text', text: input.text }] },
  });
}

function claudeAssistantLine(input: {
  timestamp: string;
  text: string;
  toolUse?: { name: string; args: Record<string, unknown> };
}): string {
  return claudeLine({
    type: 'assistant',
    uuid: `a-${input.timestamp}`,
    sessionId: 'claude-resume-fixture',
    timestamp: input.timestamp,
    message: {
      content: [
        { type: 'text', text: input.text },
        ...(input.toolUse
          ? [{ type: 'tool_use', id: 'tool-fix-1', name: input.toolUse.name, input: input.toolUse.args }]
          : []),
      ],
    },
  });
}

interface ImportedFixture {
  db: BetterSqlite3.Database;
  portabilityRepo: SessionForkPortabilityRepository;
  projectRepo: ProjectRepository;
  projectService: ProjectService;
  claudeRoot: string;
  workspace: string;
}

async function createFixture(): Promise<ImportedFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'imported-resume-'));
  tempRoots.push(root);
  const db = new Database(path.join(root, 'code-agent.db'));
  applyAllSchema(db);
  const portabilityRepo = new SessionForkPortabilityRepository(db);
  const projectRepo = new ProjectRepository(db);
  const projectService = new ProjectService(() => projectRepo);
  dbBridge.database = {
    importSessionFork: (input: unknown) => portabilityRepo.importSessionFork(input as never),
    getProjectRepo: () => projectRepo,
  };
  const claudeRoot = path.join(root, 'claude-projects');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(claudeRoot, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return { db, portabilityRepo, projectRepo, projectService, claudeRoot, workspace };
}

async function writeClaudeChat(claudeRoot: string, lines: string[]): Promise<void> {
  const sessionId = 'claude-resume-fixture';
  const sourcePath = path.join(claudeRoot, sessionId, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, `${lines.join('\n')}\n`);
}

function runImport(fixture: ImportedFixture) {
  return importRecentExternalChats({
    ownerScopeId: LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
    now: () => NOW,
    roots: {
      claudeProjectsRoot: fixture.claudeRoot,
      codexSessionsRoot: path.join(path.dirname(fixture.claudeRoot), 'codex-sessions'),
    },
    historyService: new AgentEngineHistoryImportService({
      roots: {
        claudeProjectsRoot: fixture.claudeRoot,
        codexSessionsRoot: path.join(path.dirname(fixture.claudeRoot), 'codex-sessions'),
      },
    }),
    resolveProject: (cwd, now) => fixture.projectService.ensureProjectForWorkspace(cwd, now),
    hasExistingImport: () => false,
    importFork: (input) => new SessionHistoryAppService(
      () => null as unknown as TaskManager,
    ).importSessionFork({
      envelope: input.envelope,
      targetProjectId: input.targetProjectId,
      namespace: input.namespace,
    }),
  });
}

type SessionRow = Record<string, unknown>;

function sessionRow(db: BetterSqlite3.Database, sessionId: string): SessionRow {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!row) throw new Error(`session ${sessionId} was not found`);
  return row;
}

function importedSessionId(db: BetterSqlite3.Database): string {
  const row = db.prepare(
    "SELECT id FROM sessions WHERE origin LIKE '%\"kind\":\"import\"%' LIMIT 1",
  ).get() as { id: string } | undefined;
  if (!row) throw new Error('no imported session was found');
  return row.id;
}

function messageRows(db: BetterSqlite3.Database, sessionId: string): SessionRow[] {
  return db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC',
  ).all(sessionId) as SessionRow[];
}

function messageFingerprint(rows: SessionRow[]): { count: number; hash: string } {
  const projection = rows.map((row) => [
    row.id, row.role, row.content, row.timestamp, row.tool_calls, row.content_parts,
  ]);
  return {
    count: rows.length,
    hash: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  };
}

function forkService(db: BetterSqlite3.Database, defaultModel = DEFAULT_MODEL): SessionForkService {
  const forkRepo = new SessionForkRepository(db);
  return new SessionForkService({
    getSession: (sessionId: string, options?: { includeDeleted?: boolean; userId?: string | null }) => {
      const row = options?.includeDeleted
        ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined
        : db.prepare('SELECT * FROM sessions WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(sessionId) as SessionRow | undefined;
      if (!row) return null;
      const session = rowToSession(row) as Session & { isDeleted?: boolean };
      if (options?.userId !== undefined && session.userId !== options.userId) return null;
      return session;
    },
    createSessionFork: (input) => forkRepo.createFork(input),
    getSessionForkLineage: (sessionId: string, ownerUserId?: string | null) =>
      forkRepo.getLineage(sessionId, ownerUserId),
    listSessionForkChildren: (sessionId: string, ownerUserId?: string | null) =>
      forkRepo.listChildren(sessionId, ownerUserId),
  }, {
    resolveDefaultModelConfig: async () => defaultModel,
  });
}

describe('imported external-history fork-on-send persistence', () => {
  let fixture: ImportedFixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    fixture.db.close();
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('imports the fixture chat with its tool call, then forks a native child without touching the source', async () => {
    await writeClaudeChat(fixture.claudeRoot, [
      claudeUserLine({
        timestamp: '2026-10-20T10:00:00.000Z',
        text: `Our project codeword is ${CODEWORD}. Read the config to confirm.`,
        cwd: fixture.workspace,
      }),
      claudeAssistantLine({
        timestamp: '2026-10-20T10:00:01.000Z',
        text: 'Reading the config now.',
        toolUse: { name: 'Read', args: { file_path: '/tmp/config.json' } },
      }),
      claudeUserLine({ timestamp: '2026-10-20T10:00:02.000Z', text: 'What did it say?' }),
      claudeAssistantLine({
        timestamp: '2026-10-20T10:00:03.000Z',
        text: `The config confirms the codeword ${CODEWORD}.`,
      }),
    ]);

    const results = await runImport(fixture);
    expect(results.map((result) => [result.sourceSessionId, result.status])).toEqual([
      ['claude-resume-fixture', 'imported'],
    ]);

    const sourceId = importedSessionId(fixture.db);
    const sourceRow = sessionRow(fixture.db, sourceId);
    // 种子形状：外部引擎 + import origin；占位模型落在 model 列（engine JSON 不带 model）。
    expect(JSON.parse(String(sourceRow.agent_engine))).toEqual({
      kind: 'claude_code',
      permissionProfile: 'read_only',
      origin: 'import',
    });
    expect(sourceRow.model_provider).toBe('claude');
    expect(sourceRow.model_name).toBe('claude-history');

    const sourceMessages = messageRows(fixture.db, sourceId);
    expect(sourceMessages.length).toBeGreaterThanOrEqual(4);
    // 工具调用以一行纯文本进入前缀（不产生 tool_calls 载荷）。
    const serialized = JSON.stringify(sourceMessages);
    expect(serialized).toContain('Read');
    expect(sourceMessages.every((row) => !row.tool_calls)).toBe(true);

    const before = messageFingerprint(sourceMessages);
    const anchor = sourceMessages[sourceMessages.length - 1];
    expect(anchor.role).toBe('assistant');

    const service = forkService(fixture.db);
    const result = await service.createFork({
      sourceSessionId: sourceId,
      anchorAssistantMessageId: String(anchor.id),
      idempotencyKey: 'imported-resume-fork-1',
      workspaceMode: 'shared_current',
    });

    expect(result.lineage.contextDeliveryMode).toBe('neo_native_prefix');
    expect(result.copiedMessageCount).toBe(before.count);

    const childRow = sessionRow(fixture.db, result.childSession.id);
    expect(JSON.parse(String(childRow.agent_engine))).toEqual({
      kind: 'native',
      permissionProfile: 'read_only',
      origin: 'manual',
    });
    expect(childRow.model_provider).toBe(DEFAULT_MODEL.provider);
    expect(childRow.model_name).toBe(DEFAULT_MODEL.model);
    expect(childRow.model_name).not.toBe('claude-history');
    expect(childRow.parent_session_id).toBe(sourceId);
    expect(JSON.parse(String(childRow.metadata)).forkLineage).toMatchObject({
      parentSessionId: sourceId,
      contextDeliveryMode: 'neo_native_prefix',
      status: 'completed',
    });
    expect((fixture.db.prepare(
      'SELECT context_delivery_mode FROM session_forks WHERE child_session_id = ?',
    ).get(result.childSession.id) as { context_delivery_mode: string }).context_delivery_mode)
      .toBe('neo_native_prefix');

    // 前缀照抄进子会话，尾消息仍是那条助手锚点。
    const childMessages = messageRows(fixture.db, result.childSession.id);
    expect(childMessages).toHaveLength(before.count);
    expect(childMessages.map((row) => row.content)).toEqual(sourceMessages.map((row) => row.content));

    // ② 原记录不被改写：行内容、engine/model 列全量不变。
    const afterMessages = messageRows(fixture.db, sourceId);
    expect(messageFingerprint(afterMessages)).toEqual(before);
    const sourceRowAfter = sessionRow(fixture.db, sourceId);
    expect(sourceRowAfter.agent_engine).toBe(sourceRow.agent_engine);
    expect(sourceRowAfter.model_provider).toBe('claude');
    expect(sourceRowAfter.model_name).toBe('claude-history');
    expect(sourceRowAfter.updated_at).toBe(sourceRow.updated_at);
  });

  it('① direct send into the imported session fails with the clear guard error and mutates nothing', async () => {
    await writeClaudeChat(fixture.claudeRoot, [
      claudeUserLine({
        timestamp: '2026-10-20T11:00:00.000Z',
        text: `Remember codeword ${CODEWORD}.`,
        cwd: fixture.workspace,
      }),
      claudeAssistantLine({
        timestamp: '2026-10-20T11:00:01.000Z',
        text: `Noted: ${CODEWORD}.`,
      }),
    ]);
    await runImport(fixture);

    const sourceId = importedSessionId(fixture.db);
    const before = messageFingerprint(messageRows(fixture.db, sourceId));
    const sourceRow = sessionRow(fixture.db, sourceId);

    // 直发路径的外部引擎闸：会话与引擎均从库里现读（与 sendMessage / web /run 同源）。
    const session = rowToSession(sourceRow) as Session;
    const engine = JSON.parse(String(sourceRow.agent_engine)) as Session['engine'];
    expect(() => resolveExternalEngineLaunch(session, engine!)).toThrow(
      /imported read-only history.*never changes/,
    );

    // 闸门抛错后源行零变化（条数 + 内容哈希 + 列值）。
    expect(messageFingerprint(messageRows(fixture.db, sourceId))).toEqual(before);
    const sourceRowAfter = sessionRow(fixture.db, sourceId);
    expect(sourceRowAfter.agent_engine).toBe(sourceRow.agent_engine);
    expect(sourceRowAfter.updated_at).toBe(sourceRow.updated_at);
  });

  it('no assistant reply at all → no valid anchor exists and a forced fork writes nothing', async () => {
    await writeClaudeChat(fixture.claudeRoot, [
      claudeUserLine({
        timestamp: '2026-10-20T12:00:00.000Z',
        text: `Set codeword ${CODEWORD}.`,
        cwd: fixture.workspace,
      }),
      claudeUserLine({ timestamp: '2026-10-20T12:00:02.000Z', text: 'Anyone there?' }),
    ]);
    await runImport(fixture);

    const sourceId = importedSessionId(fixture.db);
    const sourceMessages = messageRows(fixture.db, sourceId);
    expect(sourceMessages.every((row) => row.role === 'user')).toBe(true);
    const before = messageFingerprint(sourceMessages);
    const sessionsBefore = (fixture.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

    // 渲染层在此形状下不发 fork（blocked_no_anchor）；防御性地验证：即便硬拿
    // 用户消息当锚点，仓储也 fail-closed 且零写入。
    await expect(forkService(fixture.db).createFork({
      sourceSessionId: sourceId,
      anchorAssistantMessageId: String(sourceMessages[sourceMessages.length - 1].id),
      idempotencyKey: 'imported-resume-fork-no-anchor',
      workspaceMode: 'shared_current',
    })).rejects.toMatchObject({ code: 'ANCHOR_NOT_COMPLETED_ASSISTANT' });

    expect(messageFingerprint(messageRows(fixture.db, sourceId))).toEqual(before);
    expect((fixture.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count)
      .toBe(sessionsBefore);
  });
});
