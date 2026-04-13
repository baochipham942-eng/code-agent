// ============================================================================
// Read (native ToolModule) Tests — P0-6.3 Batch 1
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

import { readModule } from '../../../../../src/main/tools/modules/file/read';

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

describe('readModule (native)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-native-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('has correct metadata', () => {
      expect(readModule.schema.name).toBe('Read');
      expect(readModule.schema.readOnly).toBe(true);
      expect(readModule.schema.allowInPlanMode).toBe(true);
      expect(readModule.schema.permissionLevel).toBe('read');
      expect(readModule.schema.inputSchema.required).toContain('file_path');
    });
  });

  describe('validation', () => {
    it('rejects missing file_path', async () => {
      const handler = await readModule.createHandler();
      const result = await handler.execute({}, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string file_path', async () => {
      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: 123 }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: path.join(tmpDir, 'x.txt') },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: path.join(tmpDir, 'x.txt') },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('reading files', () => {
    it('reads an existing file with line numbers', async () => {
      const file = path.join(tmpDir, 'hello.txt');
      await fs.writeFile(file, 'line1\nline2\nline3', 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('1\tline1');
        expect(result.output).toContain('2\tline2');
        expect(result.output).toContain('3\tline3');
      }
    });

    it('supports offset/limit for partial reads', async () => {
      const file = path.join(tmpDir, 'big.txt');
      const content = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n');
      await fs.writeFile(file, content, 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: file, offset: 10, limit: 3 },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('10\tline10');
        expect(result.output).toContain('11\tline11');
        expect(result.output).toContain('12\tline12');
        expect(result.output).not.toContain('line13');
        expect(result.output).toContain('more lines');
      }
    });

    it('truncates long lines to 2000 chars', async () => {
      const file = path.join(tmpDir, 'long.txt');
      await fs.writeFile(file, 'x'.repeat(3000), 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('...');
        // length = prefix (6 + tab) + 2000 chars + "..."
        const parts = result.output.split('\t');
        expect(parts[1].length).toBeLessThanOrEqual(2003);
      }
    });

    it('returns ENOENT for non-existent file', async () => {
      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: path.join(tmpDir, 'missing.txt') },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ENOENT');
        expect(result.error).toContain('not found');
      }
    });

    it('rejects .xlsx with redirect hint', async () => {
      const file = path.join(tmpDir, 'data.xlsx');
      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('read_xlsx');
      }
    });

    it('rejects .pdf with redirect hint', async () => {
      const file = path.join(tmpDir, 'doc.pdf');
      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('read_pdf');
      }
    });

    it('resolves relative paths against workingDir', async () => {
      const file = path.join(tmpDir, 'rel.txt');
      await fs.writeFile(file, 'relative content', 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: 'rel.txt' },
        makeCtx({ workingDir: tmpDir }),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('relative content');
      }
    });
  });

  describe('embedded param compatibility', () => {
    it('parses "file offset=N limit=N" format', async () => {
      const file = path.join(tmpDir, 'embed.txt');
      const content = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n');
      await fs.writeFile(file, content, 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: `${file} offset=5 limit=2` },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('5\tL5');
        expect(result.output).toContain('6\tL6');
      }
    });

    it('parses "file lines 3-5" format', async () => {
      const file = path.join(tmpDir, 'lines.txt');
      const content = Array.from({ length: 10 }, (_, i) => `R${i + 1}`).join('\n');
      await fs.writeFile(file, content, 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: `${file} lines 3-5` },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('3\tR3');
        expect(result.output).toContain('5\tR5');
        expect(result.output).not.toContain('6\tR6');
      }
    });
  });

  describe('progress events', () => {
    it('emits starting and completing stages on success', async () => {
      const file = path.join(tmpDir, 'p.txt');
      await fs.writeFile(file, 'ok', 'utf-8');

      const events: string[] = [];
      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: file },
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
