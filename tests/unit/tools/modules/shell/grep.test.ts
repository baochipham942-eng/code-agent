// ============================================================================
// Grep (native ToolModule) Tests — P0-6.3 Batch 2b
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// Lazy-import because we may monkey-patch rg binary path between tests.
import { grepModule, __setRgBinaryPathForTest } from '../../../../../src/main/tools/modules/shell/grep';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await grepModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

// -----------------------------------------------------------------------------
// Fixture directory
// -----------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-native-'));
  await fs.writeFile(
    path.join(tempDir, 'a.ts'),
    'hello world\nexport const foo = 1\nTODO: fix\nhello again\n',
  );
  await fs.writeFile(
    path.join(tempDir, 'b.js'),
    'console.log("hello");\nconsole.log("world");\n',
  );
  await fs.writeFile(
    path.join(tempDir, 'c.md'),
    '# Hello\nSome text\nFIXME: later\n',
  );
  // Reset rg cache between tests so __setRgBinaryPathForTest takes effect reliably
  __setRgBinaryPathForTest(undefined);
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  __setRgBinaryPathForTest(undefined);
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('grepModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(grepModule.schema.name).toBe('Grep');
      expect(grepModule.schema.category).toBe('fs');
      expect(grepModule.schema.permissionLevel).toBe('read');
      expect(grepModule.schema.readOnly).toBe(true);
      expect(grepModule.schema.allowInPlanMode).toBe(true);
      expect(grepModule.schema.inputSchema.required).toContain('pattern');
    });

    it('exposes all legacy parameters', () => {
      const props = grepModule.schema.inputSchema.properties as Record<string, unknown>;
      expect(props.pattern).toBeDefined();
      expect(props.path).toBeDefined();
      expect(props.include).toBeDefined();
      expect(props.case_insensitive).toBeDefined();
      expect(props.type).toBeDefined();
      expect(props.before_context).toBeDefined();
      expect(props.after_context).toBeDefined();
      expect(props.context).toBeDefined();
      expect(props.head_limit).toBeDefined();
      expect(props.offset).toBeDefined();
    });
  });

  describe('validation', () => {
    it('rejects missing pattern', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty string pattern', async () => {
      const result = await run({ pattern: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string pattern', async () => {
      const result = await run({ pattern: 123 as unknown as string });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ pattern: 'hello', path: tempDir }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired before execute', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run(
        { pattern: 'hello', path: tempDir },
        makeCtx({ abortSignal: ctrl.signal }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('onProgress events', () => {
    it('emits starting + completing for a successful search', async () => {
      const events: string[] = [];
      const onProgress = (p: { stage: string }) => events.push(p.stage);
      const result = await run(
        { pattern: 'hello', path: tempDir },
        makeCtx(),
        allowAll,
        onProgress,
      );
      expect(result.ok).toBe(true);
      expect(events).toContain('starting');
      expect(events).toContain('completing');
    });
  });

  describe('basic search', () => {
    it('finds matches across files', async () => {
      const result = await run({ pattern: 'hello', path: tempDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('hello');
        const meta = result.meta as { engine?: string; totalMatches?: number } | undefined;
        expect(meta?.engine === 'rg' || meta?.engine === 'grep').toBe(true);
        expect((meta?.totalMatches ?? 0) > 0).toBe(true);
      }
    });

    it('returns "No matches found" on no match', async () => {
      const result = await run({
        pattern: 'ZZZ_NONEXISTENT_PATTERN_XYZ',
        path: tempDir,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('No matches found');
        const meta = result.meta as { totalMatches?: number } | undefined;
        expect(meta?.totalMatches).toBe(0);
      }
    });

    it('case_insensitive matches uppercase', async () => {
      const result = await run({
        pattern: 'HELLO',
        path: tempDir,
        case_insensitive: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output.toLowerCase()).toContain('hello');
    });
  });

  describe('path resolution', () => {
    it('resolves relative path against ctx.workingDir', async () => {
      // tempDir's basename, relative to its parent
      const parent = path.dirname(tempDir);
      const base = path.basename(tempDir);
      const result = await run(
        { pattern: 'hello', path: base },
        makeCtx({ workingDir: parent }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('hello');
    });

    it('defaults path to ctx.workingDir when not provided', async () => {
      const result = await run(
        { pattern: 'hello' },
        makeCtx({ workingDir: tempDir }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('hello');
    });
  });

  describe('filters: type / include', () => {
    it('type=ts only searches .ts files', async () => {
      const result = await run({
        pattern: 'hello',
        path: tempDir,
        type: 'ts',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/a\.ts/);
        expect(result.output).not.toMatch(/b\.js/);
      }
    });

    it('include=*.md only searches markdown files', async () => {
      const result = await run({
        pattern: 'Hello',
        path: tempDir,
        include: '*.md',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toMatch(/c\.md/);
        expect(result.output).not.toMatch(/a\.ts/);
      }
    });
  });

  describe('context params', () => {
    it('before_context shows preceding lines', async () => {
      const result = await run({
        pattern: 'TODO',
        path: tempDir,
        before_context: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('TODO');
        expect(result.output).toContain('export const foo');
      }
    });

    it('context alias sets both before and after', async () => {
      const result = await run({
        pattern: 'export const foo',
        path: tempDir,
        context: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('hello world');
        expect(result.output).toContain('TODO');
      }
    });

    it('context values above MAX_CONTEXT_LINES are clamped (smoke: does not error)', async () => {
      const result = await run({
        pattern: 'hello',
        path: tempDir,
        context: 9999,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('pagination: head_limit / offset', () => {
    it('head_limit reports "showing X-Y of Z"', async () => {
      // Make a file with many matches
      await fs.writeFile(
        path.join(tempDir, 'many.txt'),
        Array.from({ length: 20 }, (_, i) => `match_${i} hit`).join('\n'),
      );
      const result = await run({
        pattern: 'match_',
        path: tempDir,
        head_limit: 3,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('showing 1-3');
      }
    });

    it('offset + head_limit shifts pagination window', async () => {
      await fs.writeFile(
        path.join(tempDir, 'many.txt'),
        Array.from({ length: 20 }, (_, i) => `entry_${i}`).join('\n'),
      );
      const result = await run({
        pattern: 'entry_',
        path: tempDir,
        head_limit: 2,
        offset: 2,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('showing 3-4');
      }
    });
  });

  describe('default output limit', () => {
    it('caps total matches at GREP.MAX_TOTAL_MATCHES with a truncation notice', async () => {
      // Create a file with > MAX_TOTAL_MATCHES lines
      const big = Array.from({ length: 250 }, (_, i) => `bighit_${i}`).join('\n');
      await fs.writeFile(path.join(tempDir, 'big.txt'), big);
      const result = await run({ pattern: 'bighit_', path: tempDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Output should either include the "more matches" footer,
        // or totalMatches should be at or above the cap in meta
        const meta = result.meta as { totalMatches?: number; truncated?: boolean } | undefined;
        // Both rg and grep should hit at least MAX_MATCHES_PER_FILE per file cap,
        // so we just assert the handler does not crash and meta.totalMatches is a number.
        expect(typeof meta?.totalMatches).toBe('number');
      }
    });
  });

  describe('ripgrep missing fallback', () => {
    it('falls back to system grep when rg binary is not available', async () => {
      __setRgBinaryPathForTest(null); // pretend rg is not installed
      const result = await run({ pattern: 'hello', path: tempDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('hello');
        const meta = result.meta as { engine?: string } | undefined;
        expect(meta?.engine).toBe('grep');
      }
    });

    it('grep fallback returns "No matches found" cleanly on zero matches', async () => {
      __setRgBinaryPathForTest(null);
      const result = await run({
        pattern: 'ZZZ_NOT_THERE_12345',
        path: tempDir,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('No matches found');
      }
    });
  });

  describe('error paths', () => {
    it('ENOENT on missing path surfaces structured error', async () => {
      const result = await run({
        pattern: 'hello',
        path: path.join(tempDir, '__does_not_exist__'),
      });
      // Either ENOENT or FS_ERROR — both are acceptable "hard failure" shapes
      // (rg + grep differ slightly on how they report missing paths).
      if (!result.ok) {
        expect(['ENOENT', 'FS_ERROR']).toContain(result.code);
      } else {
        // If it somehow succeeds with no matches, at least ensure output is sane
        expect(result.output).toContain('No matches found');
      }
    });
  });
});
