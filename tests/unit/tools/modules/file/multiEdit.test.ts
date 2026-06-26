import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { fileReadTracker } from '../../../../../src/host/tools/fileReadTracker';

vi.mock('../../../../../src/host/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import { editModule } from '../../../../../src/host/tools/modules/file/multiEdit';

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
  } as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('multiEditModule evidence metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-edit-evidence-'));
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns changedFiles and a changed file artifact after editing', async () => {
    const file = path.join(tmpDir, 'note.txt');
    await fs.writeFile(file, 'alpha\nbeta\n', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'beta', new_text: 'gamma' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Edited');
      expect(result.meta).toMatchObject({
        action: 'edit',
        operation: 'multi_edit',
        path: file,
        changedFiles: [file],
        editCount: 1,
        replacementCount: 1,
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'Edit',
        path: file,
        metadata: {
          action: 'edit',
          operation: 'multi_edit',
          path: file,
        },
      });
    }
    expect(await fs.readFile(file, 'utf-8')).toBe('alpha\ngamma\n');
  });

  it('returns nearby file context when old_text is not found', async () => {
    const file = path.join(tmpDir, 'game.html');
    await fs.writeFile(file, [
      'window.__GAME_META__ = {',
      '  gameplayMechanics: {',
      '    enemies: [{ name: "cat" }],',
      '    abilities: [',
      '      { name: "variableJump" }',
      '    ]',
      '  }',
      '};',
      '',
    ].join('\n'), 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'abilities: []', new_text: "abilities: ['doubleJump']" }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('Closest current file context');
      expect(result.error).toContain('abilities: [');
    }
  });

  it('falls back to the flexible replacer chain on whitespace-only mismatch (roadmap 1.1)', async () => {
    const file = path.join(tmpDir, 'code.ts');
    await fs.writeFile(file, 'function foo() {\n    return 1;  \n}\n', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        // old_text 行内空白与文件不一致：精确匹配失败 → LineTrimmedReplacer 回退命中
        edits: [{ old_text: 'function foo() {\nreturn 1;\n}', new_text: 'function foo() {\n    return 2;\n}' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe('function foo() {\n    return 2;\n}\n');
    if (result.ok) {
      expect(result.output).toContain('fuzzy');
    }
  });

  it('falls back to indentation-flexible matching for uniformly shifted blocks (roadmap 1.1)', async () => {
    const file = path.join(tmpDir, 'indent.ts');
    await fs.writeFile(
      file,
      ['class A {', '    method() {', '        return 1;', '    }', '}', ''].join('\n'),
      'utf-8',
    );
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{
          old_text: ['method() {', '    return 1;', '}'].join('\n'),
          new_text: ['method() {', '    return 42;', '}'].join('\n'),
        }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    const after = await fs.readFile(file, 'utf-8');
    expect(after).toContain('return 42;');
    // 注意：替换文本按原样写入（与 MiMo 行为一致，新文本缩进由模型负责）
  });

  it('does not swallow middle lines for a trailing-newline two-line old_text (codex audit R4)', async () => {
    const file = path.join(tmpDir, 'two-line.txt');
    await fs.writeFile(file, 'a\nx\nb', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'a\nb\n', new_text: 'z' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
    expect(await fs.readFile(file, 'utf-8')).toBe('a\nx\nb');
  });

  it('still reports NOT_FOUND when the flexible chain has no match', async () => {
    const file = path.join(tmpDir, 'none.ts');
    await fs.writeFile(file, 'const a = 1;\n', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'const totally_different = 9;', new_text: 'x' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('rejects editing when the read digest is stale', async () => {
    const file = path.join(tmpDir, 'stale-edit.txt');
    await fs.writeFile(file, 'abc', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);
    const originalStats = await fs.stat(file);

    await fs.writeFile(file, 'xyz', 'utf-8');
    await fs.utimes(file, originalStats.atime, originalStats.mtime);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'xyz', new_text: 'new' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STALE_FILE');
      expect(result.meta?.modification).toMatchObject({
        digestChanged: true,
      });
    }
    expect(await fs.readFile(file, 'utf-8')).toBe('xyz');
  });

  it('requires a force_reason when force bypasses edit safety', async () => {
    const file = path.join(tmpDir, 'force-edit.txt');
    await fs.writeFile(file, 'alpha', 'utf-8');

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'alpha', new_text: 'beta' }],
        force: true,
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORCE_REASON_REQUIRED');
    expect(await fs.readFile(file, 'utf-8')).toBe('alpha');
  });

  it('allows force edit with an audited reason', async () => {
    const file = path.join(tmpDir, 'force-edit-audited.txt');
    await fs.writeFile(file, 'alpha', 'utf-8');

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'alpha', new_text: 'beta' }],
        force: true,
        force_reason: 'user requested emergency patch',
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.audit).toMatchObject({
        action: 'edit_force',
        path: file,
        reason: 'user requested emergency patch',
        hadRead: false,
      });
    }
    expect(await fs.readFile(file, 'utf-8')).toBe('beta');
  });

  it('reports AMBIGUOUS_MATCH when the fuzzy match occurs multiple times without replace_all', async () => {
    const file = path.join(tmpDir, 'dup.ts');
    await fs.writeFile(file, 'x\n  a();\ny\n  a();\n', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'a();', new_text: 'b();' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AMBIGUOUS_MATCH');
  });

  it('replaces the full nested-brace block, never splicing into a truncated range (codex audit R2)', async () => {
    const original = [
      'function foo() {',
      '  if (ok) {',
      '    return value;',
      '  }',
      '  return fallback;',
      '}',
      '',
    ].join('\n');
    const file = path.join(tmpDir, 'nested.ts');
    await fs.writeFile(file, original, 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{
          // old_text 与文件仅最后一个语句不同（模型记错了标识符），整块模糊匹配
          old_text: [
            'function foo() {',
            '  if (ok) {',
            '    return value;',
            '  }',
            '  return fallbackValue;',
            '}',
          ].join('\n'),
          new_text: [
            'function foo() {',
            '  return value;',
            '}',
          ].join('\n'),
        }],
      },
      makeCtx(),
      allowAll,
    );

    const after = await fs.readFile(file, 'utf-8');
    if (result.ok) {
      // 若模糊命中，必须替换整个外层块——不允许把 new_text 拼进截断范围留下残尾
      expect(after).toBe(['function foo() {', '  return value;', '}', ''].join('\n'));
    } else {
      // 拒绝匹配也可接受（NOT_FOUND），但文件绝不能被破坏
      expect(after).toBe(original);
    }
    // 无论哪种结果，都不允许出现"残留的原尾部"腐蚀形态
    expect(after).not.toContain('return fallback;\n}\n  return');
    const closeBraces = (after.match(/^}/gm) || []).length;
    expect(closeBraces).toBeLessThanOrEqual(1);
  });

  it('does not use fuzzy fallback with replace_all (prevents indentation corruption, codex audit R1)', async () => {
    // Codex repro：candidate '  a();' 是 '    a();' 的子串，split/join 全量替换会腐蚀缩进。
    // 防护：fuzzy 回退仅限单点替换，replace_all 时直接 NOT_FOUND。
    const file = path.join(tmpDir, 'fuzzy-all.ts');
    await fs.writeFile(file, '  a();\n    a();\n', 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        // 'a();' 精确匹配两处 → 不走 fuzzy（AMBIGUOUS 由精确路径处理）；
        // 这里用带不同缩进的多行块强制 fuzzy 路径
        edits: [{ old_text: 'a();\n  a();', new_text: 'b();', replace_all: true }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
    // 文件未被破坏
    expect(await fs.readFile(file, 'utf-8')).toBe('  a();\n    a();\n');
  });

  it('confines eval absolute repo paths to the sandbox', async () => {
    const realRoot = path.join(tmpDir, 'repo');
    const sandbox = path.join(tmpDir, 'sandbox');
    const realFile = path.join(realRoot, 'note.txt');
    const sandboxFile = path.join(sandbox, 'note.txt');
    const previousRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
    process.env.CODE_AGENT_EVAL_REAL_ROOT = realRoot;

    try {
      await fs.mkdir(path.dirname(sandboxFile), { recursive: true });
      await fs.writeFile(sandboxFile, 'alpha\nbeta\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(sandboxFile);

      const handler = await editModule.createHandler();
      const result = await handler.execute(
        {
          file_path: realFile,
          edits: [{ old_text: 'beta', new_text: 'gamma' }],
        },
        makeCtx({ workingDir: sandbox }),
        allowAll,
      );

      expect(result.ok).toBe(true);
      expect(await fs.readFile(sandboxFile, 'utf-8')).toBe('alpha\ngamma\n');
      await expect(fs.access(realFile)).rejects.toThrow();
      if (result.ok) expect(result.meta?.path).toBe(sandboxFile);
    } finally {
      if (previousRealRoot === undefined) {
        delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      } else {
        process.env.CODE_AGENT_EVAL_REAL_ROOT = previousRealRoot;
      }
    }
  });
});
