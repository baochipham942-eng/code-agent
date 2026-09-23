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
} from '../../../../../src/host/protocol/tools';
import { fileReadTracker } from '../../../../../src/host/tools/fileReadTracker';

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { readModule } from '../../../../../src/host/tools/modules/file/read';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
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
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
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

    it('tells a single-value read to Grep then use a narrow window, and documents embedded offset/limit', () => {
      const description = readModule.schema.description;
      expect(description).toContain('Grep');
      expect(description).toContain('version');
      expect(description).toContain('offset=N limit=N');
      expect(description).toContain('lines N-M');
      expect(description).toContain('default 2000');
      const properties = readModule.schema.inputSchema.properties as Record<string, { description?: string }>;
      expect(properties.limit.description).toContain('Default 2000');
      expect(properties.limit.description).toContain('small limit');
      expect(properties.file_path.description).toContain('offset=N limit=N');
      expect(properties.file_path.description).toContain('lines N-M');
      expect(properties.offset.description).toContain('Grep');
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
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'Read',
          path: file,
        });
      }
    });

    it('returns a read EvidenceRef with digest and shown range metadata', async () => {
      const file = path.join(tmpDir, 'evidence.txt');
      await fs.writeFile(file, 'alpha\nbeta\ngamma\n', 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: file, offset: 2, limit: 1 },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta?.evidenceRef).toMatchObject({
          kind: 'read',
          ref: `${file}#L2-L2`,
          source: 'Read',
          freshness: {
            state: 'read',
            digest: expect.any(String),
          },
          redactionStatus: 'clean',
        });
        expect(result.meta?.shownRange).toEqual({
          startLine: 2,
          endLine: 2,
          totalLines: 4,
        });
        const record = fileReadTracker.getReadRecord(file);
        expect(record?.digest).toBe(result.meta?.digest);
        expect(record?.evidenceRef).toEqual(result.meta?.evidenceRef);
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
        expect(result.output).toContain('[Read incomplete] Showed lines 10-12 (3 lines).');
        expect(result.output).toContain('88 lines remain unread and were not returned.');
        expect(result.output).toContain('Continue with Read offset=13');
        expect(result.output.trimEnd().endsWith('... (88 more lines)')).toBe(true);
      }
    });

    it('keeps the default 2000-line window and fail-loud when the file is longer', async () => {
      const file = path.join(tmpDir, 'over-default.txt');
      const content = Array.from({ length: 2001 }, (_, i) => `L${i + 1}`).join('\n');
      await fs.writeFile(file, content, 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('2000\tL2000');
        expect(result.output).not.toContain('\tL2001');
        expect(result.output).toContain('[Read incomplete] Showed lines 1-2000 (2000 lines).');
        expect(result.output).toContain('1 line remains unread and was not returned.');
        expect(result.output).toContain('Continue with Read offset=2001');
        expect(result.output.trimEnd().endsWith('... (1 more lines)')).toBe(true);
      }
    });

    it('does not add an incomplete notice when the window covers the file', async () => {
      const file = path.join(tmpDir, 'short.txt');
      await fs.writeFile(file, 'only\n', 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).not.toContain('[Read incomplete]');
        expect(result.output).not.toContain('more lines');
      }
    });

    it('truncates long lines to 2000 chars and says how many chars were not returned', async () => {
      const file = path.join(tmpDir, 'long.txt');
      await fs.writeFile(file, 'x'.repeat(3000), 'utf-8');

      const handler = await readModule.createHandler();
      const result = await handler.execute({ file_path: file }, makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('... [line truncated; 1000 chars on this line were not returned]');
        const body = result.output.split('\t')[1] ?? '';
        expect(body.startsWith('x'.repeat(2000))).toBe(true);
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

  it('always returns file content on repeated reads and keeps stale-edit evidence across forgetShownRanges', async () => {
    const file = path.join(tmpDir, 'repeat.txt');
    await fs.writeFile(file, 'alpha\nbeta\ngamma');
    const handler = await readModule.createHandler();
    const read = (extra: Record<string, unknown> = {}) => handler.execute({ file_path: file, ...extra }, makeCtx(), allowAll);
    await read();
    // 同范围重复读必须仍返回正文（PTC 程序化调用直接消费返回值，不能拿到回执）
    const repeated = await read({ offset: 2, limit: 1 });
    expect(repeated).toMatchObject({ ok: true, output: expect.stringContaining('beta') });
    expect(repeated.meta).not.toMatchObject({ deduplicated: true });
    fileReadTracker.forgetShownRanges();
    const kept = fileReadTracker.getReadRecord(file, 'test-session:test-agent');
    expect(kept?.digest).toBeDefined();
    expect(kept?.shownRange).toBeUndefined();
    expect(await read()).toMatchObject({ output: expect.stringContaining('alpha') });
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
        expect(result.output).toContain('[Read incomplete] Showed lines 5-6 (2 lines).');
        expect(result.output).toContain('44 lines remain unread and were not returned.');
        expect(result.output).toContain('Continue with Read offset=7');
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
