// MemoryRead 成功之后才写 access_count / last_accessed_at。
// getDatabase 指到临时目录里的真 DatabaseService，recordMemoryAccess 走生产实现。
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

vi.unmock('better-sqlite3');

vi.mock('../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return {
    loadBetterSqlite3: () => module.default,
    betterSqlite3CandidatePaths: () => [],
  };
});

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

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { memoryEntryMetadata } from '../../../src/host/memory/memoryEntryMetadata';
import { recordMemoryInjectionTrace } from '../../../src/host/memory/memoryInjectionTrace';
import { packMemoryEntries, rebuildMemoryMirrorFromLightFiles } from '../../../src/host/memory/memoryEntryRuntime';
import { memoryReadModule } from '../../../src/host/tools/modules/lightMemory/memoryRead';
import { memorySearchModule } from '../../../src/host/tools/modules/lightMemory/memorySearch';
import { getProjectMemoriesDir, getRoleMemoriesDir } from '../../../src/host/services/roleAssets/roleAssetPaths';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

describe('memory read usage writeback', () => {
  let previousDataDir: string | undefined;
  let dataDir = '';
  let memDir = '';
  let workspaceDir = '';
  let database: DatabaseService | null = null;
  let seq = 0;

  function db(): DatabaseService {
    if (!database) throw new Error('database not ready');
    return database;
  }

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    const ctrl = new AbortController();
    return {
      sessionId: 'test-session',
      workingDir: workspaceDir,
      abortSignal: ctrl.signal,
      logger: makeLogger(),
      emit: () => undefined,
      ...overrides,
    };
  }

  function lightFile(title: string, body: string): string {
    return `---
name: ${title}
description: fixture ${title}
type: user
---

${body}
`;
  }

  async function mirrorFile(filename: string, body: string): Promise<string> {
    await fs.writeFile(path.join(memDir, filename), lightFile(filename, body), 'utf8');
    const rebuilt = await rebuildMemoryMirrorFromLightFiles(db());
    expect(rebuilt.skipped).toEqual([]);
    const row = db().listMemories({
      includeArchived: true,
      includeCandidates: true,
      limit: 1000,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    }).find((memory) => memoryEntryMetadata(memory)?.filePath === filename);
    if (!row) throw new Error(`mirror row missing for ${filename}`);
    return row.id;
  }

  function usage(id: string): { accessCount: number; lastAccessedAt: number | null } {
    const row = db().getMemory(id);
    if (!row) throw new Error(`missing row ${id}`);
    return {
      accessCount: row.accessCount,
      lastAccessedAt: typeof row.lastAccessedAt === 'number' ? row.lastAccessedAt : null,
    };
  }

  async function executeRead(
    args: Record<string, unknown>,
    ctx: ToolContext,
    permit: CanUseToolFn = allowAll,
  ) {
    const handler = await memoryReadModule.createHandler();
    return handler.execute(args, ctx, permit);
  }

  function nextId(prefix: string): { filename: string; runId: string } {
    seq += 1;
    return { filename: `${prefix}-${seq}.md`, runId: `${prefix}-run-${seq}` };
  }

  beforeAll(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-usage-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    memDir = path.join(dataDir, 'memory');
    workspaceDir = path.join(dataDir, 'workspace');
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
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

  it('(a) successful MemoryRead of a mirrored entry increments access_count and sets last_accessed_at', async () => {
    const { filename, runId } = nextId('mirrored');
    const id = await mirrorFile(filename, 'mirrored body for writeback');
    expect(usage(id)).toEqual({ accessCount: 0, lastAccessedAt: null });

    const before = Date.now();
    const result = await executeRead({ filename }, makeCtx({ runId }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain('mirrored body for writeback');

    const after = usage(id);
    expect(after.accessCount).toBe(1);
    expect(after.lastAccessedAt).toBeGreaterThanOrEqual(before);
    expect(after.lastAccessedAt).toBeLessThanOrEqual(Date.now());
  });

  it('(a) explicit global scope writes the same way', async () => {
    const { filename, runId } = nextId('explicit-global');
    const id = await mirrorFile(filename, 'explicit global body');
    const result = await executeRead({ filename, scope: 'global' }, makeCtx({ runId }));
    expect(result.ok).toBe(true);
    expect(usage(id).accessCount).toBe(1);
    expect(usage(id).lastAccessedAt).not.toBeNull();
  });

  it('(b) repeated reads in one run count once, a new run counts again', async () => {
    const { filename, runId } = nextId('idempotent');
    const other = nextId('idempotent-other');
    const id = await mirrorFile(filename, 'idempotent body');
    const otherId = await mirrorFile(other.filename, 'other entry body');
    const sessionId = `session-${runId}`;
    const sameRun = makeCtx({ runId, sessionId });

    expect((await executeRead({ filename }, sameRun)).ok).toBe(true);
    expect(usage(id).accessCount).toBe(1);
    const stamped = usage(id).lastAccessedAt;

    expect((await executeRead({ filename, scope: 'global' }, sameRun)).ok).toBe(true);
    expect(usage(id)).toEqual({ accessCount: 1, lastAccessedAt: stamped });

    expect((await executeRead({ filename: other.filename }, makeCtx({ runId, sessionId }))).ok).toBe(true);
    expect(usage(otherId).accessCount).toBe(1);
    expect(usage(id).accessCount).toBe(1);

    expect((await executeRead({ filename }, makeCtx({ runId: `${runId}-next`, sessionId }))).ok).toBe(true);
    expect(usage(id).accessCount).toBe(2);
  });

  it('(b) sessionId is the run key when runId is absent', async () => {
    const { filename } = nextId('session-key');
    const id = await mirrorFile(filename, 'session key body');
    const sessionId = `session-only-${filename}`;

    expect((await executeRead({ filename }, makeCtx({ sessionId }))).ok).toBe(true);
    expect((await executeRead({ filename }, makeCtx({ sessionId }))).ok).toBe(true);
    expect(usage(id).accessCount).toBe(1);

    expect((await executeRead({ filename }, makeCtx({ runId: `run-over-${filename}`, sessionId }))).ok).toBe(true);
    expect(usage(id).accessCount).toBe(2);
  });

  it('(c) injection and memory_search alone leave access_count at 0', async () => {
    const { filename } = nextId('injected-only');
    const token = `zirconusagetoken${filename.replace('.md', '')}`;
    const id = await mirrorFile(
      filename,
      `citation [[memory:${filename}]] [#mem_fake] ${token}`,
    );
    expect(usage(id).accessCount).toBe(0);

    const packed = await packMemoryEntries({ query: token }, db());
    expect(packed.items.some((item) => item.content.includes(token))).toBe(true);
    recordMemoryInjectionTrace({
      blockType: 'automatic_memory',
      trigger: 'unit-injection',
      injected: true,
      source: 'unit',
      sessionId: 'inject-session',
      count: packed.selectedCount,
    });

    const search = await memorySearchModule.createHandler();
    const searched = await search.execute({ query: token }, makeCtx(), allowAll);
    expect(searched.ok).toBe(true);
    if (!searched.ok) throw new Error(searched.error);
    expect(searched.meta?.count).toBe(1);

    expect(usage(id)).toEqual({ accessCount: 0, lastAccessedAt: null });
  });

  it('(d) ENOENT, bad filename, permission denied, and abort leave access_count at 0', async () => {
    const { filename, runId } = nextId('failed');
    const id = await mirrorFile(filename, 'failed read body');
    const ctx = makeCtx({ runId });

    await fs.rm(path.join(memDir, filename));
    const missing = await executeRead({ filename }, ctx);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('ENOENT');

    await fs.writeFile(path.join(memDir, filename), lightFile(filename, 'failed read body'), 'utf8');
    const badExt = await executeRead({ filename: filename.replace(/\.md$/, '.txt') }, ctx);
    expect(badExt.ok).toBe(false);
    if (!badExt.ok) expect(badExt.code).toBe('INVALID_ARGS');

    const traversal = await executeRead({ filename: `../${filename}` }, ctx);
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.code).toBe('INVALID_ARGS');

    const denied = await executeRead({ filename }, ctx, denyAll);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('PERMISSION_DENIED');

    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await executeRead({ filename }, makeCtx({ runId, abortSignal: ctrl.signal }));
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.code).toBe('ABORTED');

    const unknown = await executeRead({ filename, scope: 'team' }, ctx);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('INVALID_ARGS');

    expect(usage(id)).toEqual({ accessCount: 0, lastAccessedAt: null });
  });

  it('(e) a database failure still returns the file content and does not write', async () => {
    const { filename, runId } = nextId('db-throws');
    const marker = 'db-throws body still returned';
    const id = await mirrorFile(filename, marker);
    const logger = makeLogger();
    const unready = new DatabaseService(path.join(dataDir, 'unready'));
    dbHolder.current = unready;
    try {
      const result = await executeRead({ filename }, makeCtx({ runId, logger }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.output).toContain(marker);
      expect(logger.debug).toHaveBeenCalledWith(
        'MemoryRead usage writeback skipped',
        expect.objectContaining({ filename, error: expect.any(String) }),
      );
    } finally {
      unready.close();
      dbHolder.current = database;
    }
    expect(usage(id)).toEqual({ accessCount: 0, lastAccessedAt: null });
  });

  it('(e) a missing mirror row still returns the file content', async () => {
    const { filename, runId } = nextId('no-mirror');
    const marker = 'no-mirror body still returned';
    await fs.writeFile(path.join(memDir, filename), lightFile(filename, marker), 'utf8');
    const decoy = db().createMemory({
      type: 'project_knowledge',
      category: 'context',
      content: 'db memory with the same filename',
      summary: 'decoy',
      source: 'user_defined',
      confidence: 1,
      metadata: {
        memoryEntry: {
          sourceOfTruth: 'db_memory',
          filePath: filename,
        },
      },
    });
    const logger = makeLogger();
    const result = await executeRead({ filename }, makeCtx({ runId, logger }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain(marker);
    expect(usage(decoy.id)).toEqual({ accessCount: 0, lastAccessedAt: null });
    expect(logger.debug).toHaveBeenCalledWith(
      'MemoryRead usage writeback skipped',
      expect.objectContaining({ filename, reason: 'missing-mirror' }),
    );
  });

  it('an archived light_file mirror is not written', async () => {
    const { filename, runId } = nextId('archived');
    const id = await mirrorFile(filename, 'archived body');
    db().updateMemory(id, { status: 'archived' });
    const result = await executeRead({ filename }, makeCtx({ runId }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain('archived body');
    expect(usage(id)).toEqual({ accessCount: 0, lastAccessedAt: null });
  });

  it('a non-archived candidate mirror is written', async () => {
    const { filename, runId } = nextId('candidate');
    const id = await mirrorFile(filename, 'candidate body');
    db().updateMemory(id, { status: 'candidate' });
    const result = await executeRead({ filename }, makeCtx({ runId }));
    expect(result.ok).toBe(true);
    expect(usage(id).accessCount).toBe(1);
  });

  it('(f) role and project reads do not write back', async () => {
    const { filename, runId } = nextId('scoped');
    const id = await mirrorFile(filename, 'global marker for scope');
    const roleDir = getRoleMemoriesDir('role-alpha');
    const projectDir = getProjectMemoriesDir(workspaceDir);
    await fs.mkdir(roleDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(roleDir, filename), lightFile(filename, 'role marker body'), 'utf8');
    await fs.writeFile(path.join(projectDir, filename), lightFile(filename, 'project marker body'), 'utf8');

    const roleResult = await executeRead(
      { filename, scope: 'role' },
      makeCtx({ runId, subagent: { agentRole: 'role-alpha' } }),
    );
    expect(roleResult.ok).toBe(true);
    if (!roleResult.ok) throw new Error(roleResult.error);
    expect(roleResult.output).toContain('role marker body');

    const projectResult = await executeRead(
      { filename, scope: 'project' },
      makeCtx({ runId: `${runId}-project` }),
    );
    expect(projectResult.ok).toBe(true);
    if (!projectResult.ok) throw new Error(projectResult.error);
    expect(projectResult.output).toContain('project marker body');
    expect(usage(id)).toEqual({ accessCount: 0, lastAccessedAt: null });
  });

  it('keeps at most 64 run keys in insertion order', async () => {
    const { filename } = nextId('fifo');
    const id = await mirrorFile(filename, 'fifo body');
    const handler = await memoryReadModule.createHandler();
    const readRun = async (runId: string) => {
      const result = await handler.execute({ filename }, makeCtx({ runId: `fifo-${runId}` }), allowAll);
      expect(result.ok).toBe(true);
    };

    for (let index = 1; index <= 64; index += 1) {
      await readRun(String(index));
    }
    expect(usage(id).accessCount).toBe(64);

    await readRun('1');
    expect(usage(id).accessCount).toBe(64);

    await readRun('65');
    expect(usage(id).accessCount).toBe(65);

    await readRun('2');
    expect(usage(id).accessCount).toBe(65);

    await readRun('1');
    expect(usage(id).accessCount).toBe(66);
  });
});
