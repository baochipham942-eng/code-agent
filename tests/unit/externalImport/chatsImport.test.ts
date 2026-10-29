// ============================================================================
// chatsImport 单测（N-EXTHISTORY-IMPORT-CHATS-HOST）—— 批量导入最近外部会话
// ============================================================================
//
// 覆盖验收①-⑤⑧：
// ① 30 天窗口 + 单次 50 上限（两引擎合并、新→旧）；
// ② 真 sqlite 两轮导入：第二轮全 already_imported、行数不变；源文件追加（digest 变）后
//    仍 already_imported，不触发 SYNC_ID_DIGEST_CONFLICT；
// ③ cwd 在盘上 → 归属该项目；cwd 缺失 → folder_missing（不写库、不抛、同批其余照常）；
//    源里没有 cwd → 未分类项目；
// ④ 工具调用落成一行纯文本（工具名 + 一行参数），无工具结果文本、无 tool_call parts；
// ⑤ 持久化行 origin 带 kind=import、name='<engine> history'，exportId 确定性可复现。
//
// 持久化路径与生产同构：走 SessionHistoryAppService.importSessionFork（getDatabase 用
// 桥接对象指向本测试的 better-sqlite3 实例，schema 按 SessionForkPortabilityRepository
// 测试同款搭法），预检走 SessionForkPortabilityRepository.hasImportedExport。

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const dbBridge = vi.hoisted(() => ({
  database: null as unknown,
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbBridge.database,
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getProjectSourceGitStates: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ invalidateSessionCache: () => {} }),
}));

import { SessionHistoryAppService } from '../../../src/host/app/sessionHistoryAppService';
import { importRecentExternalChats } from '../../../src/host/externalImport/chatsImport';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { applySessionForkPortabilitySchema } from '../../../src/host/services/core/database/schemaSessionForkPortability';
import {
  ProjectRepository,
} from '../../../src/host/services/core/repositories/ProjectRepository';
import {
  SessionForkPortabilityRepository,
} from '../../../src/host/services/core/repositories/SessionForkPortabilityRepository';
import { ProjectService } from '../../../src/host/services/project/projectService';
import type { TaskManager } from '../../../src/host/task/TaskManager';
import type { Project } from '../../../src/shared/contract/project';
import { AgentEngineHistoryImportService } from '../../../src/host/services/agentEngine/agentEngineHistoryImport';
import { UNSORTED_PROJECT_ID } from '../../../src/shared/contract/project';
import { LOCAL_SESSION_FORK_OWNER_SCOPE_ID } from '../../../src/shared/contract/sessionForkPortability';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const NOW_FN = () => NOW;
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

interface HistoryRoots {
  root: string;
  claude: string;
  codex: string;
}

async function createHistoryRoots(): Promise<HistoryRoots> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-import-'));
  tempRoots.push(root);
  const claude = path.join(root, 'claude-projects');
  const codex = path.join(root, 'codex-sessions');
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(codex, { recursive: true });
  return { root, claude, codex };
}

function claudeLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function claudeUserLine(input: {
  sessionId: string;
  timestamp: string;
  text: string;
  cwd?: string;
}): string {
  return claudeLine({
    type: 'user',
    uuid: `u-${input.sessionId}-${input.timestamp}`,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    message: { content: [{ type: 'text', text: input.text }] },
  });
}

function claudeAssistantToolLine(input: {
  sessionId: string;
  timestamp: string;
  name: string;
  args: Record<string, unknown>;
}): string {
  return claudeLine({
    type: 'assistant',
    uuid: `a-${input.sessionId}-${input.timestamp}`,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    message: {
      content: [
        { type: 'text', text: 'assistant reply' },
        { type: 'tool_use', id: `tool-${input.sessionId}`, name: input.name, input: input.args },
      ],
    },
  });
}

function claudeToolResultLine(input: {
  sessionId: string;
  timestamp: string;
  output: string;
}): string {
  return claudeLine({
    type: 'user',
    uuid: `t-${input.sessionId}-${input.timestamp}`,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    message: { content: [{ type: 'tool_result', tool_use_id: `tool-${input.sessionId}`, content: input.output }] },
  });
}

function claudeAssistantTextLine(input: {
  sessionId: string;
  timestamp: string;
  text: string;
}): string {
  return claudeLine({
    type: 'assistant',
    uuid: `a-${input.sessionId}-${input.timestamp}`,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    message: { content: [{ type: 'text', text: input.text }] },
  });
}

async function writeClaudeChat(input: {
  claudeRoot: string;
  sessionId: string;
  lines: string[];
}): Promise<string> {
  const sourcePath = path.join(input.claudeRoot, input.sessionId, `${input.sessionId}.jsonl`);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, `${input.lines.join('\n')}\n`);
  return sourcePath;
}

async function writeCodexChat(input: {
  codexRoot: string;
  sessionId: string;
  cwd?: string;
  lines?: string[];
  mtime?: Date;
}): Promise<string> {
  const sourcePath = path.join(
    input.codexRoot,
    '2026',
    '10',
    '20',
    `rollout-2026-10-20T09-00-00-${input.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const lines = input.lines ?? [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: input.sessionId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        timestamp: '2026-10-10T09:00:00.000Z',
      },
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test', sandbox_policy: 'read-only' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: `codex chat ${input.sessionId}`, timestamp: '2026-10-10T09:00:01.000Z' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'codex answer', timestamp: '2026-10-10T09:00:02.000Z' },
    }),
  ];
  await fs.writeFile(sourcePath, `${lines.join('\n')}\n`);
  if (input.mtime) {
    await fs.utimes(sourcePath, input.mtime, input.mtime);
  }
  return sourcePath;
}

function historyServiceFor(roots: HistoryRoots): AgentEngineHistoryImportService {
  return new AgentEngineHistoryImportService({
    roots: { claudeProjectsRoot: roots.claude, codexSessionsRoot: roots.codex },
  });
}

const stubProjectResolver = async () => ({ id: 'project-import-batch' }) as Project;

describe('importRecentExternalChats candidate selection', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('imports only chats updated within 30 days, at most 50 per run, merged newest-first across engines', async () => {
    const roots = await createHistoryRoots();
    // 60 个窗口内 Claude 会话：chat-00 最旧，chat-59 最新。
    for (let index = 0; index < 60; index += 1) {
      const stamp = new Date(Date.parse('2026-10-05T00:00:00.000Z') + index * 3_600_000)
        .toISOString();
      await writeClaudeChat({
        claudeRoot: roots.claude,
        sessionId: `chat-${String(index).padStart(2, '0')}`,
        lines: [
          claudeUserLine({ sessionId: `chat-${String(index).padStart(2, '0')}`, timestamp: stamp, text: `chat-${String(index).padStart(2, '0')}` }),
          claudeAssistantTextLine({ sessionId: `chat-${String(index).padStart(2, '0')}`, timestamp: new Date(Date.parse(stamp) + 1000).toISOString(), text: 'ok' }),
        ],
      });
    }
    // 窗口外的 Claude 会话（消息时间 2026-08）必须被排除。
    await writeClaudeChat({
      claudeRoot: roots.claude,
      sessionId: 'chat-ancient',
      lines: [
        claudeUserLine({ sessionId: 'chat-ancient', timestamp: '2026-08-15T10:00:00.000Z', text: 'chat-ancient' }),
        claudeAssistantTextLine({ sessionId: 'chat-ancient', timestamp: '2026-08-15T10:00:01.000Z', text: 'ok' }),
      ],
    });
    // 两个窗口内 Codex 会话（mtime 2026-10-20，比全部 Claude 会话新）+ 一个窗口外的。
    await writeCodexChat({ codexRoot: roots.codex, sessionId: 'codex-recent-a', mtime: new Date('2026-10-20T10:00:00Z') });
    await writeCodexChat({ codexRoot: roots.codex, sessionId: 'codex-recent-b', mtime: new Date('2026-10-20T09:00:00Z') });
    await writeCodexChat({ codexRoot: roots.codex, sessionId: 'codex-ancient', mtime: new Date('2026-08-15T10:00:00Z') });

    const importFork = vi.fn();
    const results = await importRecentExternalChats({
      ownerScopeId: 'owner-batch',
      now: NOW_FN,
      roots: { claudeProjectsRoot: roots.claude, codexSessionsRoot: roots.codex },
      resolveProject: stubProjectResolver,
      hasExistingImport: () => false,
      importFork,
    });

    expect(results).toHaveLength(50);
    expect(results.every((result) => result.status === 'imported')).toBe(true);
    expect(results.map((result) => result.sourceSessionId).slice(0, 2)).toEqual([
      'codex-recent-a',
      'codex-recent-b',
    ]);
    const claudeTitles = results.slice(2).map((result) => result.sourceSessionId);
    expect(claudeTitles[0]).toBe('chat-59');
    expect(claudeTitles.at(-1)).toBe('chat-12');
    expect(claudeTitles).not.toContain('chat-00');
    expect(claudeTitles).not.toContain('chat-11');
    expect(results.map((result) => result.sourceSessionId)).not.toContain('chat-ancient');
    expect(results.map((result) => result.sourceSessionId)).not.toContain('codex-ancient');
    expect(importFork).toHaveBeenCalledTimes(50);
  });
});

describe('importRecentExternalChats on a real sqlite database', () => {
  let db: BetterSqlite3.Database;
  let portabilityRepo: SessionForkPortabilityRepository;
  let projectService: ProjectService;
  let roots: HistoryRoots;

  beforeEach(async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-import-db-'));
    tempRoots.push(dbDir);
    db = new Database(path.join(dbDir, 'code-agent.db'));
    applyAllSchema(db);
    portabilityRepo = new SessionForkPortabilityRepository(db);
    const projectRepo = new ProjectRepository(db);
    projectService = new ProjectService(() => projectRepo);
    dbBridge.database = {
      importSessionFork: (input: unknown) => portabilityRepo.importSessionFork(input as never),
      getProjectRepo: () => projectRepo,
    };
    roots = await createHistoryRoots();
  });

  afterEach(async () => {
    db.close();
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  function runImport() {
    return importRecentExternalChats({
      ownerScopeId: LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
      now: NOW_FN,
      roots: { claudeProjectsRoot: roots.claude, codexSessionsRoot: roots.codex },
      resolveProject: (cwd, now) => projectService.ensureProjectForWorkspace(cwd, now),
      hasExistingImport: (query) => portabilityRepo.hasImportedExport(
        query.sourceExportId,
        query.ownerScopeId,
        query.projectId,
        query.namespace,
      ),
      importFork: (input) => new SessionHistoryAppService(
        () => null as unknown as TaskManager,
      ).importSessionFork({
        envelope: input.envelope,
        targetProjectId: input.targetProjectId,
        namespace: input.namespace,
      }),
    });
  }

  function countRows(table: 'sessions' | 'messages' | 'session_fork_portability_imports'): number {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  it('running twice imports nothing twice, even after the source file grows', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-import-ws-'));
    tempRoots.push(workspace);
    const claudePath = await writeClaudeChat({
      claudeRoot: roots.claude,
      sessionId: 'claude-two-run',
      lines: [
        claudeUserLine({ sessionId: 'claude-two-run', timestamp: '2026-10-10T10:00:00.000Z', text: 'claude two-run', cwd: workspace }),
        claudeAssistantTextLine({ sessionId: 'claude-two-run', timestamp: '2026-10-10T10:00:01.000Z', text: 'first answer' }),
      ],
    });
    await writeCodexChat({ codexRoot: roots.codex, sessionId: 'codex-two-run', cwd: workspace, mtime: new Date('2026-10-20T10:00:00Z') });

    const firstRun = await runImport();
    expect(firstRun.map((result) => [result.sourceSessionId, result.status])).toEqual([
      ['codex-two-run', 'imported'],
      ['claude-two-run', 'imported'],
    ]);
    const sessionsAfterFirst = countRows('sessions');
    const messagesAfterFirst = countRows('messages');
    const importsAfterFirst = countRows('session_fork_portability_imports');
    expect(sessionsAfterFirst).toBe(2);
    expect(importsAfterFirst).toBe(2);
    expect(messagesAfterFirst).toBeGreaterThan(0);

    const secondRun = await runImport();
    expect(secondRun.map((result) => [result.sourceSessionId, result.status])).toEqual([
      ['codex-two-run', 'already_imported'],
      ['claude-two-run', 'already_imported'],
    ]);
    expect(countRows('sessions')).toBe(sessionsAfterFirst);
    expect(countRows('messages')).toBe(messagesAfterFirst);
    expect(countRows('session_fork_portability_imports')).toBe(importsAfterFirst);

    // 源文件追加消息 → payload digest 变了，但确定性 exportId 判重必须直接跳过，
    // 不允许撞 importSessionFork 的 SYNC_ID_DIGEST_CONFLICT。
    await fs.appendFile(claudePath, `${claudeUserLine({ sessionId: 'claude-two-run', timestamp: '2026-10-11T10:00:00.000Z', text: 'grown', cwd: workspace })}\n`);
    const thirdRun = await runImport();
    expect(thirdRun.map((result) => [result.sourceSessionId, result.status])).toEqual([
      ['codex-two-run', 'already_imported'],
      ['claude-two-run', 'already_imported'],
    ]);
    expect(countRows('sessions')).toBe(sessionsAfterFirst);
    expect(countRows('session_fork_portability_imports')).toBe(importsAfterFirst);

    const importRows = db.prepare('SELECT source_export_id FROM session_fork_portability_imports ORDER BY source_export_id').all() as Array<{ source_export_id: string }>;
    expect(importRows.map((row) => row.source_export_id)).toEqual([
      'external-history:claude_code:claude-two-run',
      'external-history:codex_cli:codex-two-run',
    ]);
  });

  it('binds cwd to its project when on disk, reports folder_missing without writing when gone, and unsorts cwd-less chats', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-import-ws-'));
    tempRoots.push(workspace);
    await writeClaudeChat({
      claudeRoot: roots.claude,
      sessionId: 'claude-bound',
      lines: [
        claudeUserLine({ sessionId: 'claude-bound', timestamp: '2026-10-12T10:00:00.000Z', text: 'claude bound', cwd: workspace }),
        claudeAssistantTextLine({ sessionId: 'claude-bound', timestamp: '2026-10-12T10:00:01.000Z', text: 'ok' }),
      ],
    });
    await writeClaudeChat({
      claudeRoot: roots.claude,
      sessionId: 'claude-ghost',
      lines: [
        claudeUserLine({ sessionId: 'claude-ghost', timestamp: '2026-10-13T10:00:00.000Z', text: 'claude ghost', cwd: path.join(roots.root, 'definitely-missing') }),
        claudeAssistantTextLine({ sessionId: 'claude-ghost', timestamp: '2026-10-13T10:00:01.000Z', text: 'ok' }),
      ],
    });
    await writeClaudeChat({
      claudeRoot: roots.claude,
      sessionId: 'claude-nocwd',
      lines: [
        claudeUserLine({ sessionId: 'claude-nocwd', timestamp: '2026-10-14T10:00:00.000Z', text: 'claude nocwd' }),
        claudeAssistantTextLine({ sessionId: 'claude-nocwd', timestamp: '2026-10-14T10:00:01.000Z', text: 'ok' }),
      ],
    });

    const results = await runImport();

    expect(results.map((result) => [result.sourceSessionId, result.status])).toEqual([
      ['claude-nocwd', 'imported'],
      ['claude-ghost', 'folder_missing'],
      ['claude-bound', 'imported'],
    ]);
    expect(results[1].reason).toContain('definitely-missing');

    // folder_missing：该会话一行都没写；同批其余两条照常导入。
    expect(countRows('sessions')).toBe(2);
    expect(countRows('session_fork_portability_imports')).toBe(2);

    const boundProject = await projectService.ensureProjectForWorkspace(workspace, NOW);
    const sessionRows = db.prepare('SELECT id, project_id, origin FROM sessions').all() as Array<{
      id: string;
      project_id: string;
      origin: string;
    }>;
    const byExportSession = new Map(
      sessionRows.map((row) => [JSON.parse(row.origin).metadata.sourceExportId, row]),
    );
    expect(byExportSession.get('external-history:claude_code:claude-bound')?.project_id).toBe(boundProject.id);
    expect(byExportSession.get('external-history:claude_code:claude-nocwd')?.project_id).toBe(UNSORTED_PROJECT_ID);
  });

  it('keeps tool use as one plain-text line without tool results or tool_call parts, tagging engine history origin', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-import-ws-'));
    tempRoots.push(workspace);
    await writeClaudeChat({
      claudeRoot: roots.claude,
      sessionId: 'claude-tools',
      lines: [
        claudeUserLine({ sessionId: 'claude-tools', timestamp: '2026-10-15T10:00:00.000Z', text: 'claude tools', cwd: workspace }),
        claudeAssistantToolLine({
          sessionId: 'claude-tools',
          timestamp: '2026-10-15T10:00:01.000Z',
          name: 'synthetic_tool',
          args: { file_path: '/synthetic/repo/notes.md' },
        }),
        claudeToolResultLine({ sessionId: 'claude-tools', timestamp: '2026-10-15T10:00:02.000Z', output: 'tool output secret' }),
      ],
    });
    await writeCodexChat({
      codexRoot: roots.codex,
      sessionId: 'codex-tools',
      cwd: workspace,
      mtime: new Date('2026-10-20T10:00:00Z'),
      lines: [
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex-tools', cwd: workspace, timestamp: '2026-10-10T09:00:00.000Z' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'codex tools', timestamp: '2026-10-10T09:00:01.000Z' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'call-1', name: 'synthetic_tool', arguments: '{"command":"ls -la /synthetic"}' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'tool output secret' },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'codex answer', timestamp: '2026-10-10T09:00:02.000Z' } }),
      ],
    });

    const results = await runImport();
    expect(results.map((result) => [result.sourceSessionId, result.status])).toEqual([
      ['codex-tools', 'imported'],
      ['claude-tools', 'imported'],
    ]);

    const messageRows = db.prepare(`
      SELECT s.id AS session_id, m.role, m.content, m.content_parts
      FROM messages m JOIN sessions s ON s.id = m.session_id
      ORDER BY s.id, m.timestamp
    `).all() as Array<{ session_id: string; role: string; content: string; content_parts: string | null }>;
    const allContent = messageRows.map((row) => row.content).join('\n');
    expect(allContent).toContain('synthetic_tool /synthetic/repo/notes.md');
    expect(allContent).toContain('synthetic_tool ls -la /synthetic');
    expect(allContent).not.toContain('tool output secret');
    expect(messageRows.every((row) => (row.content_parts ?? '').includes('tool_call') === false)).toBe(true);

    const sessionRows = db.prepare('SELECT id, origin FROM sessions').all() as Array<{ id: string; origin: string }>;
    const origins = new Map(sessionRows.map((row) => {
      const parsed = JSON.parse(row.origin) as { kind: string; name: string };
      return [row.id, parsed];
    }));
    const claudeOrigin = [...origins.entries()].find(([, origin]) => origin.name === 'claude_code history');
    const codexOrigin = [...origins.entries()].find(([, origin]) => origin.name === 'codex_cli history');
    expect(claudeOrigin?.[1].kind).toBe('import');
    expect(codexOrigin?.[1].kind).toBe('import');
  });
});
