// ============================================================================
// Glob (native ToolModule) Tests — P0-6.3 Batch 1
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

vi.mock('../../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { globModule } from '../../../../../src/main/tools/migrated/file/glob';

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

describe('globModule (native)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-native-'));
    // seed: a.ts, b.ts, sub/c.ts, sub/d.md
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'x', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'x', 'utf-8');
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'sub', 'c.ts'), 'x', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'sub', 'd.md'), 'x', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('has correct metadata', () => {
      expect(globModule.schema.name).toBe('Glob');
      expect(globModule.schema.readOnly).toBe(true);
      expect(globModule.schema.allowInPlanMode).toBe(true);
      expect(globModule.schema.permissionLevel).toBe('read');
      expect(globModule.schema.inputSchema.required).toContain('pattern');
    });
  });

  describe('validation', () => {
    it('rejects missing pattern', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute({}, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string pattern', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute({ pattern: 123 }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '**/*.ts', path: tmpDir },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '**/*.ts', path: tmpDir },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('matching files', () => {
    it('finds files by recursive pattern', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '**/*.ts', path: tmpDir },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('a.ts');
        expect(result.output).toContain('b.ts');
        expect(result.output).toContain('c.ts');
        expect(result.output).not.toContain('d.md');
      }
    });

    it('finds files by simple glob', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '*.ts', path: tmpDir },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('a.ts');
        expect(result.output).toContain('b.ts');
        expect(result.output).not.toContain('c.ts');
      }
    });

    it('returns "No files matched" on empty results', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '**/*.nonexistent', path: tmpDir },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('No files matched the pattern');
    });

    it('defaults path to ctx.workingDir', async () => {
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '**/*.ts' },
        makeCtx({ workingDir: tmpDir }),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('a.ts');
      }
    });

    it('ignores node_modules by default', async () => {
      await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'hidden.ts'), 'x', 'utf-8');

      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '**/*.ts', path: tmpDir },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).not.toContain('hidden.ts');
    });
  });

  describe('progress events', () => {
    it('emits starting and completing stages on success', async () => {
      const events: string[] = [];
      const handler = await globModule.createHandler();
      const result = await handler.execute(
        { pattern: '*.ts', path: tmpDir },
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
