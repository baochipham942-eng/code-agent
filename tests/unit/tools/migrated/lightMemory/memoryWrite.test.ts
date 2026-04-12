// ============================================================================
// MemoryWrite (native ToolModule) Tests
// Tests write/delete, validation, INDEX.md auto-maintenance, canUseTool gate
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { memoryWriteModule } from '../../../../../src/main/tools/migrated/lightMemory/memoryWrite';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function runWrite(args: Record<string, unknown>, ctxOverrides: Partial<ToolContext> = {}) {
  const handler = await memoryWriteModule.createHandler();
  return handler.execute(args, makeCtx(ctxOverrides), allowAll);
}

describe('memoryWriteModule (native)', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-write-native-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('has correct name and write metadata', () => {
      expect(memoryWriteModule.schema.name).toBe('MemoryWrite');
      expect(memoryWriteModule.schema.permissionLevel).toBe('write');
      expect(memoryWriteModule.schema.readOnly).toBe(false);
      expect(memoryWriteModule.schema.inputSchema.required).toContain('action');
      expect(memoryWriteModule.schema.inputSchema.required).toContain('filename');
    });
  });

  describe('validation', () => {
    it('rejects filename not ending with .md', async () => {
      const result = await runWrite({ action: 'write', filename: 'test.txt' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('.md');
    });

    it('rejects filename with path separators', async () => {
      const result = await runWrite({ action: 'write', filename: '../etc/passwd.md' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('path separators');
    });

    it('rejects unknown action', async () => {
      const result = await runWrite({ action: 'update', filename: 'test.md' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Unknown action');
    });

    it('rejects write with missing name', async () => {
      const result = await runWrite({
        action: 'write',
        filename: 'test.md',
        description: 'desc',
        type: 'user',
        content: 'content',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('name, description, type, content');
    });

    it('rejects write with missing content', async () => {
      const result = await runWrite({
        action: 'write',
        filename: 'test.md',
        name: 'Test',
        description: 'desc',
        type: 'user',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('name, description, type, content');
    });

    it('rejects invalid memory type', async () => {
      const result = await runWrite({
        action: 'write',
        filename: 'test.md',
        name: 'Test',
        description: 'desc',
        type: 'invalid',
        content: 'content',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Invalid type');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(
        {
          action: 'write',
          filename: 'x.md',
          name: 'X',
          description: 'd',
          type: 'user',
          content: 'c',
        },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(
        {
          action: 'write',
          filename: 'x.md',
          name: 'X',
          description: 'd',
          type: 'user',
          content: 'c',
        },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('write action', () => {
    it('creates a memory file with frontmatter', async () => {
      const result = await runWrite({
        action: 'write',
        filename: 'user_role.md',
        name: 'User Role',
        description: 'User role and background',
        type: 'user',
        content: 'Product Manager with 14 years experience',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('user_role.md');

      const fileContent = await fs.readFile(path.join(memDir, 'user_role.md'), 'utf-8');
      expect(fileContent).toContain('---');
      expect(fileContent).toContain('name: User Role');
      expect(fileContent).toContain('description: User role and background');
      expect(fileContent).toContain('type: user');
      expect(fileContent).toContain('Product Manager with 14 years experience');
    });

    it('creates INDEX.md on first write', async () => {
      await runWrite({
        action: 'write',
        filename: 'first_memory.md',
        name: 'First',
        description: 'First memory entry',
        type: 'project',
        content: 'Hello world',
      });

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain('[first_memory.md]');
      expect(indexContent).toContain('First memory entry');
    });

    it('updates INDEX.md entry on overwrite', async () => {
      await runWrite({
        action: 'write',
        filename: 'evolving.md',
        name: 'Evolving',
        description: 'Original description',
        type: 'project',
        content: 'Version 1',
      });
      await runWrite({
        action: 'write',
        filename: 'evolving.md',
        name: 'Evolving',
        description: 'Updated description',
        type: 'project',
        content: 'Version 2',
      });

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain('Updated description');
      const entries = indexContent.split('\n').filter((l) => l.includes('[evolving.md]'));
      expect(entries.length).toBe(1);
    });

    it('accepts all four valid types', async () => {
      const types = ['user', 'feedback', 'project', 'reference'] as const;

      for (const type of types) {
        const result = await runWrite({
          action: 'write',
          filename: `${type}_test.md`,
          name: `${type} test`,
          description: `Testing ${type} type`,
          type,
          content: `Content for ${type}`,
        });
        expect(result.ok).toBe(true);
      }

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      for (const type of types) {
        expect(indexContent).toContain(`[${type}_test.md]`);
      }
    });
  });

  describe('delete action', () => {
    it('deletes an existing memory file', async () => {
      await runWrite({
        action: 'write',
        filename: 'to_delete.md',
        name: 'Delete Me',
        description: 'Will be deleted',
        type: 'feedback',
        content: 'Temporary',
      });

      const exists = await fs
        .stat(path.join(memDir, 'to_delete.md'))
        .then(() => true, () => false);
      expect(exists).toBe(true);

      const result = await runWrite({ action: 'delete', filename: 'to_delete.md' });
      expect(result.ok).toBe(true);

      const existsAfter = await fs
        .stat(path.join(memDir, 'to_delete.md'))
        .then(() => true, () => false);
      expect(existsAfter).toBe(false);
    });

    it('removes entry from INDEX.md on delete', async () => {
      await runWrite({
        action: 'write',
        filename: 'keep.md',
        name: 'Keep',
        description: 'Keep this',
        type: 'user',
        content: 'Staying',
      });
      await runWrite({
        action: 'write',
        filename: 'remove.md',
        name: 'Remove',
        description: 'Remove this',
        type: 'user',
        content: 'Going away',
      });

      await runWrite({ action: 'delete', filename: 'remove.md' });

      const indexContent = await fs.readFile(path.join(memDir, 'INDEX.md'), 'utf-8');
      expect(indexContent).toContain('[keep.md]');
      expect(indexContent).not.toContain('[remove.md]');
    });

    it('succeeds even if file does not exist (idempotent)', async () => {
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(path.join(memDir, 'INDEX.md'), '# Memory Index\n', 'utf-8');

      const result = await runWrite({ action: 'delete', filename: 'nonexistent.md' });
      expect(result.ok).toBe(true);
    });
  });

  describe('progress events', () => {
    it('emits starting and completing on successful write', async () => {
      const events: string[] = [];
      const handler = await memoryWriteModule.createHandler();
      const result = await handler.execute(
        {
          action: 'write',
          filename: 'progress.md',
          name: 'P',
          description: 'd',
          type: 'user',
          content: 'c',
        },
        makeCtx(),
        allowAll,
        (p) => events.push(p.stage),
      );
      expect(result.ok).toBe(true);
      expect(events).toContain('starting');
      expect(events).toContain('completing');
    });
  });
});
