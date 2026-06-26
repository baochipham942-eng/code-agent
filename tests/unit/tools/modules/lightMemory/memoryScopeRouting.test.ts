// ============================================================================
// MemoryWrite/Read scope 参数测试 — 三层记忆路由（持久化角色资产）
// scope='global'（默认/向后兼容）/ 'role' / 'project'
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
  getAgentsMdDir: () => ({ user: path.join(mockConfigDir.dir, 'agents') }),
}));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { memoryWriteModule } from '../../../../../src/host/tools/modules/lightMemory/memoryWrite';
import { memoryReadModule } from '../../../../../src/host/tools/modules/lightMemory/memoryRead';
import { ensureRoleAssetDirs } from '../../../../../src/host/services/roleAssets/roleAssetService';
import { getProjectKey } from '../../../../../src/host/services/roleAssets/roleAssetPaths';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/test-workspace',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

const writeArgs = (scope?: string, filename = 'scoped-test.md') => ({
  action: 'write',
  filename,
  name: '测试记忆',
  description: '一条测试描述',
  type: 'reference',
  content: '测试内容：用户的业务口径是 GMV 不含退款。',
  ...(scope ? { scope } : {}),
});

describe('memory scope routing (三层记忆)', () => {
  beforeEach(async () => {
    mockConfigDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-scope-'));
  });

  afterEach(async () => {
    await fs.rm(mockConfigDir.dir, { recursive: true, force: true });
  });

  describe('MemoryWrite scope', () => {
    it('schema declares scope enum', () => {
      const scopeProp = memoryWriteModule.schema.inputSchema.properties?.scope as { enum?: string[] };
      expect(scopeProp?.enum).toEqual(['global', 'role', 'project']);
    });

    it('defaults to global scope (向后兼容)', async () => {
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(writeArgs(), makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      // 写到全局 memory 目录
      const globalFile = path.join(mockConfigDir.dir, 'memory', 'scoped-test.md');
      expect(await fs.readFile(globalFile, 'utf-8')).toContain('GMV 不含退款');
    });

    it('routes scope=role to roles/<roleId>/memories/ via ctx.subagent.agentRole', async () => {
      await ensureRoleAssetDirs('研究员');
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(
        writeArgs('role'),
        makeCtx({ subagent: { agentRole: '研究员' } }),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.meta?.scope).toBe('role');

      const roleFile = path.join(mockConfigDir.dir, 'roles', '研究员', 'memories', 'scoped-test.md');
      expect(await fs.readFile(roleFile, 'utf-8')).toContain('GMV 不含退款');

      // 角色记忆索引同步更新
      const roleIndex = await fs.readFile(
        path.join(mockConfigDir.dir, 'roles', '研究员', 'MEMORY.md'),
        'utf-8',
      );
      expect(roleIndex).toContain('[scoped-test.md]');
    });

    it('rejects scope=role when not running as a persistent role', async () => {
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(writeArgs('role'), makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('persistent role');
    });

    it('routes scope=project to projects/<hash>/memory/memories/ via ctx.workingDir', async () => {
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(
        writeArgs('project'),
        makeCtx({ workingDir: '/tmp/workspace-x' }),
        allowAll,
      );
      expect(result.ok).toBe(true);

      const key = getProjectKey('/tmp/workspace-x');
      const projectFile = path.join(mockConfigDir.dir, 'projects', key, 'memory', 'memories', 'scoped-test.md');
      expect(await fs.readFile(projectFile, 'utf-8')).toContain('GMV 不含退款');
    });

    it('isolates project memories between workspaces', async () => {
      const handler = await memoryWriteModule.createHandler();
      await handler.execute(
        writeArgs('project', 'ws-a-memory.md'),
        makeCtx({ workingDir: '/tmp/workspace-a' }),
        allowAll,
      );

      const keyA = getProjectKey('/tmp/workspace-a');
      const keyB = getProjectKey('/tmp/workspace-b');
      expect(
        await fs.access(path.join(mockConfigDir.dir, 'projects', keyA, 'memory', 'memories', 'ws-a-memory.md')).then(() => true, () => false),
      ).toBe(true);
      expect(
        await fs.access(path.join(mockConfigDir.dir, 'projects', keyB)).then(() => true, () => false),
      ).toBe(false);
    });

    it('deletes scoped memory with scope param', async () => {
      await ensureRoleAssetDirs('研究员');
      const handler = await memoryWriteModule.createHandler();
      const ctx = makeCtx({ subagent: { agentRole: '研究员' } });
      await handler.execute(writeArgs('role'), ctx, allowAll);

      const result = await handler.execute(
        { action: 'delete', filename: 'scoped-test.md', scope: 'role' },
        ctx,
        allowAll,
      );
      expect(result.ok).toBe(true);

      const roleFile = path.join(mockConfigDir.dir, 'roles', '研究员', 'memories', 'scoped-test.md');
      expect(await fs.access(roleFile).then(() => true, () => false)).toBe(false);
    });

    it('rejects unknown scope', async () => {
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(writeArgs('team'), makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Unknown scope');
    });
  });

  describe('MemoryRead scope', () => {
    it('schema declares scope enum', () => {
      const scopeProp = memoryReadModule.schema.inputSchema.properties?.scope as { enum?: string[] };
      expect(scopeProp?.enum).toEqual(['global', 'role', 'project']);
    });

    it('reads role-scoped memory written by MemoryWrite', async () => {
      await ensureRoleAssetDirs('研究员');
      const ctx = makeCtx({ subagent: { agentRole: '研究员' } });

      const writeHandler = await memoryWriteModule.createHandler();
      await writeHandler.execute(writeArgs('role'), ctx, allowAll);

      const readHandler = await memoryReadModule.createHandler();
      const result = await readHandler.execute(
        { filename: 'scoped-test.md', scope: 'role' },
        ctx,
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('GMV 不含退款');
    });

    it('does not find role memory in global scope (层隔离)', async () => {
      await ensureRoleAssetDirs('研究员');
      const ctx = makeCtx({ subagent: { agentRole: '研究员' } });

      const writeHandler = await memoryWriteModule.createHandler();
      await writeHandler.execute(writeArgs('role'), ctx, allowAll);

      const readHandler = await memoryReadModule.createHandler();
      const result = await readHandler.execute({ filename: 'scoped-test.md' }, ctx, allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ENOENT');
    });

    it('rejects scope=role without role context', async () => {
      const readHandler = await memoryReadModule.createHandler();
      const result = await readHandler.execute(
        { filename: 'any.md', scope: 'role' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('persistent role');
    });
  });
});
