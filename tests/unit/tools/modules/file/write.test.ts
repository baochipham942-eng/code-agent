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

const atomicWriteTestState = vi.hoisted(() => ({
  blockedContent: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock('../../../../../src/host/tools/utils/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/host/tools/utils/atomicWrite')>();
  return {
    ...actual,
    atomicWriteFile: async (filePath: string, content: string, encoding?: BufferEncoding) => {
      if (content === atomicWriteTestState.blockedContent) {
        atomicWriteTestState.entered?.();
        await atomicWriteTestState.release;
      }
      return actual.atomicWriteFile(filePath, content, encoding);
    },
  };
});

// LSP 诊断桩 — 不做实际 LSP 查询
vi.mock('../../../../../src/host/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import { writeModule } from '../../../../../src/host/tools/modules/file/write';
import { validateToolArgs } from '../../../../../src/host/agent/runtime/toolArgsValidator';

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

describe('writeModule (native)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-native-'));
    fileReadTracker.clear();
    atomicWriteTestState.blockedContent = undefined;
    atomicWriteTestState.entered = undefined;
    atomicWriteTestState.release = undefined;
  });

  afterEach(async () => {
    fileReadTracker.clear();
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

    // 根因回归（2026-07-26 真机 trace）：真机上模型实际传的是 content: ""（合法空文件
    // 意图），却被 toolArgsValidator 的共用「missing required」谓词把 '' 当 undefined
    // 打回。这里跑完整链路：先过 validateToolArgs（真实 dispatch 前置门），确认它放行，
    // 再真的调 handler 落盘 —— 断言磁盘上出现的是真实空文件，不是只断言 schema 结构。
    it('an explicit empty-string content passes the pre-dispatch validator and creates a real empty file', async () => {
      const file = path.join(tmpDir, 'explicit-empty.txt');
      const args = { file_path: file, content: '' };

      const gate = validateToolArgs('Write', writeModule.schema.inputSchema, args);
      expect(gate.ok).toBe(true);

      const handler = await writeModule.createHandler();
      const result = await handler.execute(args, makeCtx(), allowAll);
      expect(result.ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('');
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
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'Write',
          path: file,
          mimeType: 'text/plain',
          metadata: {
            action: 'created',
            contentLength: 11,
            largeSingleWriteArtifact: false,
          },
        });
      }
      const written = await fs.readFile(file, 'utf-8');
      expect(written).toBe('hello world');
    });

    it('overwrites an existing file and reports "Updated"', async () => {
      const file = path.join(tmpDir, 'exist.txt');
      await fs.writeFile(file, 'old', 'utf-8');
      await fileReadTracker.recordReadWithStats(file, { actorId: 'test-session:test-agent' });

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

    it('rejects overwriting an existing file that has not been read', async () => {
      const file = path.join(tmpDir, 'unread.txt');
      await fs.writeFile(file, 'old', 'utf-8');

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'new' },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_READ_FOR_OVERWRITE');
      }
      expect(await fs.readFile(file, 'utf-8')).toBe('old');
    });

    it('rejects overwrite when digest changed after read even if size and mtime are restored', async () => {
      const file = path.join(tmpDir, 'stale-same-shape.txt');
      await fs.writeFile(file, 'abc', 'utf-8');
      await fileReadTracker.recordReadWithStats(file, { actorId: 'test-session:test-agent' });
      const originalStats = await fs.stat(file);

      await fs.writeFile(file, 'xyz', 'utf-8');
      await fs.utimes(file, originalStats.atime, originalStats.mtime);

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'new' },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('STALE_FILE');
        expect(result.meta?.modification).toMatchObject({
          digestChanged: true,
          readDigest: expect.any(String),
          currentDigest: expect.any(String),
        });
      }
      expect(await fs.readFile(file, 'utf-8')).toBe('xyz');
    });

    it('rejects force overwrite when this agent has no read record', async () => {
      const file = path.join(tmpDir, 'force-without-read.txt');
      await fs.writeFile(file, 'old', 'utf-8');

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        {
          file_path: file,
          content: 'new',
          force: true,
          read_digest: 'invented',
          force_reason: 'attempted blind overwrite',
        },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_READ_FOR_OVERWRITE');
      }
      expect(await fs.readFile(file, 'utf-8')).toBe('old');
    });

    it('allows a stale force overwrite with this agent\'s read digest and audits it', async () => {
      const file = path.join(tmpDir, 'force-with-reason.txt');
      await fs.writeFile(file, 'old', 'utf-8');
      await fileReadTracker.recordReadWithStats(file, { actorId: 'test-session:test-agent' });
      const readDigest = fileReadTracker.getReadRecord(file, 'test-session:test-agent')?.digest;
      await fs.writeFile(file, 'externally changed', 'utf-8');

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        {
          file_path: file,
          content: 'new',
          force: true,
          read_digest: readDigest,
        },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Updated');
        expect(result.meta?.audit).toMatchObject({
          action: 'write_overwrite_force',
          path: file,
          reason: '',
          hadRead: true,
          readDigest,
          currentDigest: expect.any(String),
        });
      }
      expect(await fs.readFile(file, 'utf-8')).toBe('new');
    });

    it('rejects force when the supplied digest is not from this agent latest Read', async () => {
      const file = path.join(tmpDir, 'force-wrong-digest.txt');
      await fs.writeFile(file, 'old', 'utf-8');
      await fileReadTracker.recordReadWithStats(file, { actorId: 'test-session:test-agent' });
      await fs.writeFile(file, 'externally changed', 'utf-8');

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'new', force: true, read_digest: 'not-the-read-digest' },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('READ_DIGEST_MISMATCH');
      expect(await fs.readFile(file, 'utf-8')).toBe('externally changed');
    });

    it('does not accept a sibling agent read record', async () => {
      const file = path.join(tmpDir, 'sibling-read.txt');
      await fs.writeFile(file, 'old', 'utf-8');
      await fileReadTracker.recordReadWithStats(file, { actorId: 'test-session:agent-a' });
      const siblingDigest = fileReadTracker.getReadRecord(file, 'test-session:agent-a')?.digest;

      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'new', force: true, read_digest: siblingDigest },
        makeCtx({ agentId: 'agent-b' }),
        allowAll,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_READ_FOR_OVERWRITE');
      expect(await fs.readFile(file, 'utf-8')).toBe('old');
    });

    it('serializes sibling agents that share a session when they write the same path', async () => {
      const file = path.join(tmpDir, 'concurrent.txt');
      let releaseFirst!: () => void;
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
      atomicWriteTestState.blockedContent = 'first';
      atomicWriteTestState.entered = markFirstEntered;
      atomicWriteTestState.release = new Promise<void>((resolve) => { releaseFirst = resolve; });

      const firstHandler = await writeModule.createHandler();
      const secondHandler = await writeModule.createHandler();
      const first = firstHandler.execute(
        { file_path: file, content: 'first' },
        makeCtx({ agentId: 'agent-a' }),
        allowAll,
      );
      await firstEntered;

      let secondSettled = false;
      const second = secondHandler.execute(
        { file_path: file, content: 'second' },
        makeCtx({ agentId: 'agent-b' }),
        allowAll,
      ).finally(() => { secondSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondSettled).toBe(false);

      releaseFirst();
      expect((await first).ok).toBe(true);
      const secondResult = await second;
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) expect(secondResult.code).toBe('NOT_READ_FOR_OVERWRITE');
      expect(await fs.readFile(file, 'utf-8')).toBe('first');
    });

    it('fails loudly when agent identity is unavailable', async () => {
      const file = path.join(tmpDir, 'missing-agent.txt');
      const handler = await writeModule.createHandler();
      const result = await handler.execute(
        { file_path: file, content: 'new' },
        makeCtx({ agentId: undefined }),
        allowAll,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('MISSING_AGENT_IDENTITY');
      await expect(fs.access(file)).rejects.toThrow();
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

    it('confines eval absolute repo paths to the sandbox', async () => {
      const realRoot = path.join(tmpDir, 'repo');
      const sandbox = path.join(tmpDir, 'sandbox');
      const realFile = path.join(realRoot, 'src', 'generated.txt');
      const sandboxFile = path.join(sandbox, 'src', 'generated.txt');
      const previousRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
      process.env.CODE_AGENT_EVAL_REAL_ROOT = realRoot;

      try {
        const handler = await writeModule.createHandler();
        const result = await handler.execute(
          { file_path: realFile, content: 'confined' },
          makeCtx({ workingDir: sandbox }),
          allowAll,
        );

        expect(result.ok).toBe(true);
        expect(await fs.readFile(sandboxFile, 'utf-8')).toBe('confined');
        await expect(fs.access(realFile)).rejects.toThrow();
        if (result.ok) expect(result.meta?.outputPath).toBe(await fs.realpath(sandboxFile));
      } finally {
        if (previousRealRoot === undefined) {
          delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
        } else {
          process.env.CODE_AGENT_EVAL_REAL_ROOT = previousRealRoot;
        }
      }
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

      it('accepts a complete medium-sized generated artifact in one Write call', async () => {
        const file = path.join(tmpDir, 'huge.html');
        const handler = await writeModule.createHandler();
        const result = await handler.execute(
          { file_path: file, content: '<html>' + 'a'.repeat(13000) + '</html>' },
          makeCtx(),
          allowAll,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.output).toContain('Accepted large generated artifact in one complete Write');
          expect(result.meta?.largeSingleWriteArtifact).toBe(true);
        }
        expect(await fs.readFile(file, 'utf-8')).toContain('<html>');
      });

      it('rejects oversized new artifact writes and asks for Append', async () => {
        const file = path.join(tmpDir, 'too-huge.html');
        const handler = await writeModule.createHandler();
        const result = await handler.execute(
          { file_path: file, content: '<html>' + 'a'.repeat(170000) + '</html>' },
          makeCtx(),
          allowAll,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('PREFER_APPEND_FOR_LARGE_ARTIFACT');
          expect(result.error).toContain('Append');
          expect(result.meta?.maxSingleWriteChars).toBe(160000);
        }
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
        expect(result.meta?.artifact).toMatchObject({
          sourceTool: 'Write',
          path: file,
          metadata: {
            action: 'created',
            completenessIssues: expect.arrayContaining([
              expect.stringContaining('未闭合的括号'),
            ]),
          },
        });
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
