// ============================================================================
// Write 同路径变换产物护栏 Tests — N-WRITE-XFORM-GUARD（FB-224）
//
// 事故形态：Read 整份中文源文件 → Write 英文翻译回同一路径，原稿被静默替换。
// 护栏不变量：已存在内容 ≥ 200 字符且新内容字符数相差 > 50% 时拒写；
// 小幅编辑、小文件、未读过的新路径、显式 overwrite:true 都放行。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import { fileReadTracker } from '../../../../../src/host/tools/fileReadTracker';

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// LSP 诊断桩 — 不做实际 LSP 查询
vi.mock('../../../../../src/host/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import { writeModule } from '../../../../../src/host/tools/modules/file/write';

const ACTOR_ID = 'test-session:test-agent';

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

const GUARD_MESSAGE_SNIPPET =
  'looks like a transform of the source; write to a new path or pass overwrite:true';

/** n 个中文字符（每字一个 BMP 码元，length === n） */
function chinese(n: number): string {
  return '销'.repeat(n);
}

/** n 个 ASCII 字符 */
function english(n: number): string {
  return 'a'.repeat(n);
}

describe('writeModule transform-of-source guard (N-WRITE-XFORM-GUARD)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-xform-guard-'));
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses Read→Write of a much longer body to the same path and leaves the file byte-identical', async () => {
    const file = path.join(tmpDir, 'notice.md');
    const original = chinese(400);
    await fs.writeFile(file, original, 'utf-8');
    await fileReadTracker.recordReadWithStats(file, { actorId: ACTOR_ID });

    const handler = await writeModule.createHandler();
    const result = await handler.execute(
      { file_path: file, content: english(900) },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain(GUARD_MESSAGE_SNIPPET);
      expect(result.meta).toMatchObject({ outputPath: file, oldChars: 400, newChars: 900 });
    }
    expect(await fs.readFile(file)).toEqual(Buffer.from(original, 'utf-8'));
  });

  it('allows a small edit (10 chars changed) to a read file', async () => {
    const file = path.join(tmpDir, 'small-edit.md');
    const original = chinese(400);
    await fs.writeFile(file, original, 'utf-8');
    await fileReadTracker.recordReadWithStats(file, { actorId: ACTOR_ID });

    const edited = original.slice(0, 390) + chinese(10);
    const handler = await writeModule.createHandler();
    const result = await handler.execute(
      { file_path: file, content: edited },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe(edited);
  });

  it('allows the same big rewrite when overwrite:true is passed, and logs the bypass', async () => {
    const file = path.join(tmpDir, 'bypass.md');
    await fs.writeFile(file, chinese(400), 'utf-8');
    await fileReadTracker.recordReadWithStats(file, { actorId: ACTOR_ID });

    const logger = makeLogger();
    const handler = await writeModule.createHandler();
    const result = await handler.execute(
      { file_path: file, content: english(900), overwrite: true },
      makeCtx({ logger }),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe(english(900));
    expect(logger.warn).toHaveBeenCalledWith(
      'Write transform-of-source guard bypassed via overwrite:true',
      expect.objectContaining({ path: file, oldChars: 400, newChars: 900 }),
    );
  });

  it('does not apply the guard to a brand-new path', async () => {
    const file = path.join(tmpDir, 'brand-new.md');
    const handler = await writeModule.createHandler();
    const result = await handler.execute(
      { file_path: file, content: english(900) },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe(english(900));
  });

  it('allows rewriting an existing file under 200 chars to 3x the size', async () => {
    const file = path.join(tmpDir, 'tiny.md');
    await fs.writeFile(file, chinese(100), 'utf-8');
    await fileReadTracker.recordReadWithStats(file, { actorId: ACTOR_ID });

    const handler = await writeModule.createHandler();
    const result = await handler.execute(
      { file_path: file, content: english(300) },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe(english(300));
  });

  it('allows successive rewrites of a similar size after one allowed write', async () => {
    const file = path.join(tmpDir, 'iterative.md');
    await fs.writeFile(file, chinese(400), 'utf-8');
    await fileReadTracker.recordReadWithStats(file, { actorId: ACTOR_ID });

    const handler = await writeModule.createHandler();
    const first = await handler.execute(
      { file_path: file, content: chinese(410) },
      makeCtx(),
      allowAll,
    );
    expect(first.ok).toBe(true);

    const second = await handler.execute(
      { file_path: file, content: chinese(390) },
      makeCtx(),
      allowAll,
    );
    expect(second.ok).toBe(true);

    const third = await handler.execute(
      { file_path: file, content: chinese(420) },
      makeCtx(),
      allowAll,
    );
    expect(third.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe(chinese(420));
  });
});
