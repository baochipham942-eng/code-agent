// ============================================================================
// Write (native ToolModule) Tests — P0-6.3 Batch 1
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

// LSP 诊断桩 — 不做实际 LSP 查询
vi.mock('../../../../../src/main/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import { writeModule } from '../../../../../src/main/tools/modules/file/write';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: `test-session-${Date.now()}-${Math.random()}`,
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

describe('writeModule (native)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-native-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('has correct metadata', () => {
      expect(writeModule.schema.name).toBe('Write');
      expect(writeModule.schema.readOnly).toBe(false);
      expect(writeModule.schema.allowInPlanMode).toBe(false);
      expect(writeModule.schema.permissionLevel).toBe('write');
      expect(writeModule.schema.inputSchema.required).toEqual(['file_path', 'content']);
    });
  });

  describe('validation', () => {
    it('rejects missing file_path', async () => {
      const handler = await writeModule.createHandler();
      const result = await handler.execute({ content: 'x' }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing content', async () => {
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: path.join(tmpDir, 'x.txt') },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: path.join(tmpDir, 'x.txt'), content: 'hi' },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: path.join(tmpDir, 'x.txt'), content: 'hi' },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('writing files', () => {
    it('creates a new file', async () => {
      const file = path.join(tmpDir, 'new.txt');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'hello world' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Created');
        expect(result.output).toContain(file);
      }
      const written = await fs.readFile(file, 'utf-8');
      expect(written).toBe('hello world');
    });

    it('overwrites an existing file and reports "Updated"', async () => {
      const file = path.join(tmpDir, 'exist.txt');
      await fs.writeFile(file, 'old', 'utf-8');

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'new' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('Updated');
      expect(await fs.readFile(file, 'utf-8')).toBe('new');
    });

    it('creates parent directories automatically', async () => {
      const file = path.join(tmpDir, 'a', 'b', 'c', 'nested.txt');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'nested' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('nested');
    });

    it('writes empty string content', async () => {
      const file = path.join(tmpDir, 'empty.txt');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: '' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('');
    });
  });

  describe('code completeness detection', () => {
    it('warns on unclosed JS braces', async () => {
      const file = path.join(tmpDir, 'broken.ts');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'function foo() {\n  const x = 1;\n' },
        makeCtx(),
        allowAll,
      );
      // success=true but output has warning
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('代码完整性警告');
        expect(result.output).toContain('未闭合的括号');
      }
    });

    it('passes a well-formed JS file', async () => {
      const file = path.join(tmpDir, 'ok.ts');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'export const x = 1;\n' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).not.toContain('代码完整性警告');
    });

    it('detects invalid JSON', async () => {
      const file = path.join(tmpDir, 'bad.json');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: '{ "a": 1' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('JSON 格式错误');
    });
  });

  describe('progress events', () => {
    it('emits starting and completing stages on success', async () => {
      const file = path.join(tmpDir, 'p.txt');
      const events: string[] = [];
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'ok' },
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
