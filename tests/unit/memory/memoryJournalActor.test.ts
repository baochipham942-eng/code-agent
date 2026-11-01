// ============================================================================
// memoryJournalActor — journal actor 归因（N-MEM-JOURNAL-SOURCEJUMP-FU1 ①③）
// ============================================================================
// 角色醒来会话（origin.name = role-cadence）里 agent 的 DB 记忆写入，
// journal actor 必须记 role_wake：memory_amend 的 update/forget、压缩前 flush
// 的 create、propose_project_memory 的镜像重建。普通会话照旧 unknown/import；
// 会话读取抛错 fail-open 回 fallback 并 warn 带原因。
//
// 全部走真 sqlite（真 DatabaseService + 真 MemoryRepository），不手搓
// plain-object 仓储 mock；memory_amend / propose 用真 handler 驱动，
// flush 用真 preCompactContextHook。
// ============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../src/host/protocol/tools';

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const actorLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.unmock('better-sqlite3');

vi.mock('../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return {
    loadBetterSqlite3: () => module.default,
  };
});

// contextHooks 从 services barrel 取 getDatabase；barrel 只替换 getDatabase，
// 其余模块不加载（与 tests/unit/hooks/contextHooks.test.ts 同款做法）
vi.mock('../../../src/host/services', () => ({
  getDatabase: () => {
    if (!dbHolder.current) throw new Error('Database not initialized');
    return dbHolder.current;
  },
}));

// 工具 handler 与 memoryJournalActor 直连 databaseService，importActual 透传
// 其余导出，仅 getDatabase 指向本测试的真 DatabaseService
vi.mock('../../../src/host/services/core/databaseService', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/core/databaseService')>(
    '../../../src/host/services/core/databaseService',
  );
  return {
    ...actual,
    getDatabase: () => {
      if (!dbHolder.current) throw new Error('Database not initialized');
      return dbHolder.current as ReturnType<typeof actual.getDatabase>;
    },
  };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  createLogger: (context: string) =>
    context === 'MemoryJournalActor'
      ? actorLogger
      : { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { ROLE_PROACTIVITY } from '../../../src/shared/constants';
import { memoryAmendModule } from '../../../src/host/tools/modules/lightMemory/memoryAmend';
import { proposeProjectMemoryModule } from '../../../src/host/tools/modules/lightMemory/proposeProjectMemory';
import { preCompactContextHook } from '../../../src/host/hooks/builtins/contextHooks';
import { resolveJournalContext } from '../../../src/host/memory/memoryJournalActor';
import type { CompactContext } from '../../../src/host/protocol/events';
import type { Message } from '../../../src/shared/contract';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const allow: CanUseToolFn = async () => ({ allow: true });

function makeCtx(sessionId: string, workingDir: string): ToolContext {
  return {
    sessionId,
    workingDir,
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger,
    emit: () => undefined,
  } as ToolContext;
}

function compactContext(sessionId: string, workingDirectory: string): CompactContext {
  return {
    event: 'PreCompact',
    sessionId,
    timestamp: 1_700_000_000_000,
    workingDirectory,
    tokenCount: 10_000,
    targetTokenCount: 5_000,
  };
}

function flushMessages(marker: string): Message[] {
  return [
    {
      role: 'user',
      content: `重要：${marker} 场景下先检查邮箱给建议，在我确认前不要动任何邮件`,
      timestamp: 1_700_000_000_000 - 2000,
    } as unknown as Message,
    {
      role: 'assistant',
      content: `我决定采用${marker}的稳定方案，这是一个关键决策`,
      timestamp: 1_700_000_000_000 - 1000,
    } as unknown as Message,
  ];
}

describe('memory journal actor — role wake attribution', () => {
  let previousDataDir: string | undefined;
  let dataDir = '';
  let workspaceA = '';
  let workspaceB = '';
  let database: DatabaseService | null = null;

  function db(): DatabaseService {
    if (!database) throw new Error('database not ready');
    return database;
  }

  /** 与 wakeRole（roleProactivity.ts）同款 origin：kind=cron + name=role-cadence */
  function createWakeSession(id: string): void {
    db().createSessionWithId(id, {
      title: 'role-x · 主动巡检',
      modelConfig: { provider: 'openai', model: 'gpt-4o-mini' },
      type: 'schedule',
      origin: {
        kind: 'cron',
        name: ROLE_PROACTIVITY.CADENCE_JOB_TAG,
        metadata: { roleId: 'role-x', trigger: 'cadence' },
      },
    });
  }

  function createPlainSession(id: string): void {
    db().createSessionWithId(id, {
      title: '普通会话',
      modelConfig: { provider: 'openai', model: 'gpt-4o-mini' },
    });
  }

  function seedMemory(sessionId: string, content: string, projectPath: string): MemoryRecord {
    return db().createMemory({
      type: 'project_knowledge',
      category: 'context',
      content,
      summary: content.slice(0, 40),
      source: 'session_extracted',
      projectPath,
      sessionId,
      confidence: 0.9,
      metadata: {},
    });
  }

  beforeAll(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-journal-actor-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    workspaceA = path.join(dataDir, 'workspace-a');
    workspaceB = path.join(dataDir, 'workspace-b');
    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });
    database = new DatabaseService(dataDir);
    dbHolder.current = database;
    try {
      await database.initialize();
    } catch (error) {
      database.close();
      dbHolder.current = null;
      database = null;
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    dbHolder.current = null;
    database?.close();
    database = null;
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  });

  // --------------------------------------------------------------------------
  // memory_amend：醒来会话里 update / forget → role_wake
  // --------------------------------------------------------------------------
  it('memory_amend update inside a wake session journals actor role_wake', async () => {
    createWakeSession('wake-sess-amend-update');
    const created = seedMemory('wake-sess-amend-update', 'amendable v1', workspaceA);

    const handler = await memoryAmendModule.createHandler();
    const result = await handler.execute(
      { id: created.id, action: 'update', content: 'amended v2 by role' },
      makeCtx('wake-sess-amend-update', workspaceA),
      allow,
    );

    expect(result.ok).toBe(true);
    const rows = db().listMemoryJournal({ memoryId: created.id });
    expect(rows).toHaveLength(2); // seed create (unknown) + amend update
    expect(rows[0]).toMatchObject({
      operation: 'update',
      actor: 'role_wake',
      sessionId: 'wake-sess-amend-update',
    });
    // 种子行是测试自己 createMemory 落的，归因不受本单影响
    expect(rows[1]).toMatchObject({ operation: 'create', actor: 'unknown' });
  });

  it('memory_amend forget inside a wake session journals actor role_wake', async () => {
    createWakeSession('wake-sess-amend-forget');
    const created = seedMemory('wake-sess-amend-forget', 'stale memory to forget', workspaceA);

    const handler = await memoryAmendModule.createHandler();
    const result = await handler.execute(
      { id: created.id, action: 'forget' },
      makeCtx('wake-sess-amend-forget', workspaceA),
      allow,
    );

    expect(result.ok).toBe(true);
    expect(db().getMemory(created.id)?.status).toBe('archived');
    const rows = db().listMemoryJournal({ memoryId: created.id });
    expect(rows[0]).toMatchObject({
      operation: 'update',
      actor: 'role_wake',
      sessionId: 'wake-sess-amend-forget',
    });
  });

  it('memory_amend update in an ordinary session still journals actor unknown', async () => {
    createPlainSession('plain-sess-amend');
    const created = seedMemory('plain-sess-amend', 'plain v1', workspaceA);

    const handler = await memoryAmendModule.createHandler();
    const result = await handler.execute(
      { id: created.id, action: 'update', content: 'plain v2' },
      makeCtx('plain-sess-amend', workspaceA),
      allow,
    );

    expect(result.ok).toBe(true);
    const rows = db().listMemoryJournal({ memoryId: created.id });
    expect(rows[0]).toMatchObject({ operation: 'update', actor: 'unknown' });
  });

  // --------------------------------------------------------------------------
  // 压缩前 flush：醒来会话里 create → role_wake
  // --------------------------------------------------------------------------
  it('pre-compact flush inside a wake session journals actor role_wake', async () => {
    createWakeSession('wake-sess-flush');

    const result = await preCompactContextHook(
      compactContext('wake-sess-flush', workspaceA),
      flushMessages('醒来巡检'),
      'balanced',
    );
    expect(result.action).toBe('continue');

    const flushed = db().listMemories({
      source: 'session_extracted',
      projectPath: workspaceA,
      limit: 50,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }).filter((memory) => (memory.metadata as { flushEvent?: string } | null)?.flushEvent === 'preCompact');
    expect(flushed.length).toBeGreaterThan(0);
    for (const memory of flushed) {
      const rows = db().listMemoryJournal({ memoryId: memory.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operation: 'create',
        actor: 'role_wake',
        sessionId: 'wake-sess-flush',
      });
    }
  });

  it('pre-compact flush in an ordinary session still journals actor unknown', async () => {
    createPlainSession('plain-sess-flush');

    const result = await preCompactContextHook(
      compactContext('plain-sess-flush', workspaceB),
      flushMessages('普通会话'),
      'balanced',
    );
    expect(result.action).toBe('continue');

    const flushed = db().listMemories({
      source: 'session_extracted',
      projectPath: workspaceB,
      limit: 50,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }).filter((memory) => (memory.metadata as { flushEvent?: string } | null)?.flushEvent === 'preCompact');
    expect(flushed.length).toBeGreaterThan(0);
    for (const memory of flushed) {
      const rows = db().listMemoryJournal({ memoryId: memory.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: 'create', actor: 'unknown' });
    }
  });

  // --------------------------------------------------------------------------
  // propose_project_memory：醒来会话里镜像重建 → role_wake（普通 → import）
  // --------------------------------------------------------------------------
  it('propose_project_memory inside a wake session journals actor role_wake', async () => {
    createWakeSession('wake-sess-propose');

    const handler = await proposeProjectMemoryModule.createHandler();
    const result = await handler.execute(
      {
        topic: 'purpose',
        summary: 'wake propose summary',
        content: 'purpose body collected while waking',
        sources: ['README.md'],
      },
      makeCtx('wake-sess-propose', workspaceA),
      allow,
    );

    expect(result.ok).toBe(true);
    const entryId = result.meta?.id as string;
    expect(typeof entryId).toBe('string');
    const rows = db().listMemoryJournal({ entryId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'create',
      actor: 'role_wake',
      sessionId: 'wake-sess-propose',
    });
  });

  it('propose_project_memory in an ordinary session still journals actor import', async () => {
    createPlainSession('plain-sess-propose');

    const handler = await proposeProjectMemoryModule.createHandler();
    const result = await handler.execute(
      {
        topic: 'purpose',
        summary: 'plain propose summary',
        content: 'purpose body collected in a plain session',
        sources: ['README.md'],
      },
      makeCtx('plain-sess-propose', workspaceB),
      allow,
    );

    expect(result.ok).toBe(true);
    const entryId = result.meta?.id as string;
    const rows = db().listMemoryJournal({ entryId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'create', actor: 'import' });
  });

  // --------------------------------------------------------------------------
  // fail-open：会话读取抛错 → fallback actor + warn 带原因
  // --------------------------------------------------------------------------
  it('resolveJournalContext falls back and warns when the session lookup throws', () => {
    actorLogger.warn.mockClear();
    // 未初始化的真 DatabaseService：getSession 在 ensureDb 处抛 Database not initialized
    const uninitialized = new DatabaseService(path.join(dataDir, 'uninitialized'));
    uninitialized.close();
    const previous = dbHolder.current;
    dbHolder.current = uninitialized;
    try {
      const context = resolveJournalContext('any-session', 'import');
      expect(context).toEqual({ actor: 'import', sessionId: 'any-session' });
    } finally {
      dbHolder.current = previous;
    }
    expect(actorLogger.warn).toHaveBeenCalledTimes(1);
    const warnArg = actorLogger.warn.mock.calls[0][1] as Record<string, unknown>;
    expect(String(warnArg.reason)).toContain('Database not initialized');
  });

  it('resolveJournalContext keeps the fallback actor without a lookup when sessionId is empty', () => {
    actorLogger.warn.mockClear();
    expect(resolveJournalContext('', 'unknown')).toEqual({ actor: 'unknown', sessionId: null });
    expect(resolveJournalContext(undefined, 'import')).toEqual({ actor: 'import', sessionId: null });
    expect(actorLogger.warn).not.toHaveBeenCalled();
  });
});
