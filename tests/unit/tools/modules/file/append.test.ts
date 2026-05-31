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

import { appendModule } from '../../../../../src/main/tools/modules/file/append';

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

describe('appendModule (native)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'append-native-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct schema metadata', () => {
    expect(appendModule.schema.name).toBe('Append');
    expect(appendModule.schema.permissionLevel).toBe('write');
    expect(appendModule.schema.inputSchema.required).toEqual(['file_path', 'content']);
  });

  it('rejects invalid args', async () => {
    const handler = await appendModule.createHandler();
    const result = await handler.execute({ file_path: path.join(tmpDir, 'x.txt') }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('returns permission denied when blocked', async () => {
    const handler = await appendModule.createHandler();
    const result = await handler.execute(
      { file_path: path.join(tmpDir, 'x.txt'), content: 'hi' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('creates a file if needed and appends chunks in order', async () => {
    const file = path.join(tmpDir, 'artifact.html');
    const handler = await appendModule.createHandler();

    const first = await handler.execute(
      { file_path: file, content: '<html><body>' },
      makeCtx(),
      allowAll,
    );
    const second = await handler.execute(
      { file_path: file, content: 'hello</body></html>', final: true },
      makeCtx(),
      allowAll,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe('<html><body>hello</body></html>');
    if (second.ok) {
      expect(second.output).toContain('final chunk');
      expect(second.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'Append',
        path: file,
        mimeType: 'text/html',
        metadata: {
          final: true,
          appendedChars: 'hello</body></html>'.length,
        },
      });
      expect(second.meta?.fileSize).toBe('<html><body>hello</body></html>'.length);
    }
  });

  it('confines eval absolute repo paths to the sandbox', async () => {
    const realRoot = path.join(tmpDir, 'repo');
    const sandbox = path.join(tmpDir, 'sandbox');
    const realFile = path.join(realRoot, 'artifact.txt');
    const sandboxFile = path.join(sandbox, 'artifact.txt');
    const previousRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
    process.env.CODE_AGENT_EVAL_REAL_ROOT = realRoot;

    try {
      const handler = await appendModule.createHandler();
      const result = await handler.execute(
        { file_path: realFile, content: 'chunk' },
        makeCtx({ workingDir: sandbox }),
        allowAll,
      );

      expect(result.ok).toBe(true);
      expect(await fs.readFile(sandboxFile, 'utf-8')).toBe('chunk');
      await expect(fs.access(realFile)).rejects.toThrow();
      if (result.ok) expect(result.meta?.outputPath).toBe(sandboxFile);
    } finally {
      if (previousRealRoot === undefined) {
        delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      } else {
        process.env.CODE_AGENT_EVAL_REAL_ROOT = previousRealRoot;
      }
    }
  });
});
