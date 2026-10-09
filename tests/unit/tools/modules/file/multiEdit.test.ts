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
import { readModule } from '../../../../../src/host/tools/modules/file/read';

/** Spec copy of the escape sentence. Do not import the production helper: a blank helper would still satisfy toContain(''). */
function expectedReadThenRetryHint(toolName: 'Write' | 'Edit', absPath: string): string {
  return `To proceed: call Read with {"file_path": ${JSON.stringify(absPath)}} (no other arguments), then repeat this exact ${toolName} call.`;
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let tmpDir: string;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    workingDir: tmpDir,
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('multiEditModule evidence metadata', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-edit-evidence-'));
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('allows an eval Read followed by Edit through the real tool chain', async () => {
    const realRoot = path.join(tmpDir, 'real-root');
    const sandbox = path.join(tmpDir, 'sandbox');
    const relativePath = 'note.txt';
    const realFile = path.join(realRoot, relativePath);
    const sandboxFile = path.join(sandbox, relativePath);
    await fs.mkdir(realRoot, { recursive: true });
    await fs.mkdir(sandbox, { recursive: true });
    await fs.writeFile(realFile, 'alpha\nworking tree\n', 'utf-8');
    await fs.writeFile(sandboxFile, 'alpha\nsnapshot\n', 'utf-8');

    const previousRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
    process.env.CODE_AGENT_EVAL_REAL_ROOT = realRoot;
    try {
      const ctx = makeCtx({ workingDir: sandbox });
      const readHandler = await readModule.createHandler();
      const readResult = await readHandler.execute({ file_path: realFile }, ctx, allowAll);
      expect(readResult.ok).toBe(true);

      const editHandler = await editModule.createHandler();
      const editResult = await editHandler.execute(
        {
          file_path: realFile,
          edits: [{ old_text: 'snapshot', new_text: 'edited snapshot' }],
        },
        ctx,
        allowAll,
      );

      expect(editResult.ok).toBe(true);
      if (!editResult.ok) expect(editResult.code).not.toBe('NOT_READ');
      expect(await fs.readFile(sandboxFile, 'utf-8')).toBe('alpha\nedited snapshot\n');
      expect(await fs.readFile(realFile, 'utf-8')).toBe('alpha\nworking tree\n');
    } finally {
      if (previousRealRoot === undefined) delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      else process.env.CODE_AGENT_EVAL_REAL_ROOT = previousRealRoot;
    }
  });

  it('reads the eval sandbox snapshot instead of the working tree', async () => {
    const realRoot = path.join(tmpDir, 'real-root');
    const sandbox = path.join(tmpDir, 'sandbox');
    const relativePath = path.join('src', 'subject.txt');
    const realFile = path.join(realRoot, relativePath);
    const sandboxFile = path.join(sandbox, relativePath);
    await fs.mkdir(path.dirname(realFile), { recursive: true });
    await fs.mkdir(path.dirname(sandboxFile), { recursive: true });
    await fs.writeFile(realFile, 'working-tree-content', 'utf-8');
    await fs.writeFile(sandboxFile, 'sandbox-snapshot-content', 'utf-8');

    const previousRealRoot = process.env.CODE_AGENT_EVAL_REAL_ROOT;
    process.env.CODE_AGENT_EVAL_REAL_ROOT = realRoot;
    try {
      const handler = await readModule.createHandler();
      const result = await handler.execute(
        { file_path: realFile },
        makeCtx({ workingDir: sandbox }),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('sandbox-snapshot-content');
        expect(result.output).not.toContain('working-tree-content');
      }
    } finally {
      if (previousRealRoot === undefined) delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      else process.env.CODE_AGENT_EVAL_REAL_ROOT = previousRealRoot;
    }
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

  it('blocks edits inside an official SKILL.md section', async () => {
    const file = path.join(tmpDir, 'SKILL.md');
    const original = [
      '<!-- NEO:OFFICIAL-SKILL:BEGIN -->',
      'shipped instruction',
      '<!-- NEO:OFFICIAL-SKILL:END -->',
      '',
      'durable note',
      '',
    ].join('\n');
    await fs.writeFile(file, original, 'utf-8');
    await fileReadTracker.recordReadWithStats(file);

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'shipped instruction', new_text: 'rewritten instruction' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('OFFICIAL_SKILL_SECTION_PROTECTED');
    expect(await fs.readFile(file, 'utf-8')).toBe(original);
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
      expect(result.error).toContain('Re-read the file to see the current content.');
      expect(result.error).toContain(expectedReadThenRetryHint('Edit', file));
      expect(result.meta?.modification).toMatchObject({
        digestChanged: true,
      });
    }
    expect(await fs.readFile(file, 'utf-8')).toBe('xyz');
  });

  it('rejects an unread file with the exact Read call and keeps the force bypass after it', async () => {
    const file = path.join(tmpDir, 'unread edit', 'quote"name.txt');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'alpha', 'utf-8');

    const handler = await editModule.createHandler();
    const result = await handler.execute(
      {
        file_path: file,
        edits: [{ old_text: 'alpha', new_text: 'beta' }],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_READ');
    expect(result.meta).toBeUndefined();
    const hint = expectedReadThenRetryHint('Edit', file);
    expect(result.error).toContain(
      'File must be read before editing. Use Read first to view the current content, then make your edit.',
    );
    expect(result.error).toContain(hint);
    expect(result.error).toContain('(Use force: true with force_reason to bypass this check)');
    expect(result.error.indexOf(hint)).toBeLessThan(
      result.error.indexOf('(Use force: true with force_reason to bypass this check)'),
    );
    expect(result.error).toContain('\\"');
    const embedded = result.error.match(/call Read with (\{.*?\}) \(no other arguments\)/);
    expect(JSON.parse(embedded?.[1] ?? '{}')).toEqual({ file_path: file });
    expect(await fs.readFile(file, 'utf-8')).toBe('alpha');
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
      const canonicalSandboxFile = await fs.realpath(sandboxFile);
      await fileReadTracker.recordReadWithStats(canonicalSandboxFile);

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
      if (result.ok) expect(result.meta?.path).toBe(canonicalSandboxFile);
    } finally {
      if (previousRealRoot === undefined) {
        delete process.env.CODE_AGENT_EVAL_REAL_ROOT;
      } else {
        process.env.CODE_AGENT_EVAL_REAL_ROOT = previousRealRoot;
      }
    }
  });

  // N-EDIT-COMPLETENESS-CHECK：Write 已有的代码完整性检测接上 Edit——
  // 编辑删掉 JSON 逗号/HTML 闭合标签不再静默通过。ok 语义、审批、回滚行为都不变。
  describe('code completeness detection', () => {
    it('warns when an edit breaks JSON, without rolling back the write', async () => {
      const file = path.join(tmpDir, 'data.json');
      await fs.writeFile(file, '{\n  "a": 1,\n  "b": 2\n}\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(file);

      const handler = await editModule.createHandler();
      const result = await handler.execute(
        {
          file_path: file,
          // 删掉逗号：编辑后 JSON 不再可解析
          edits: [{ old_text: '"a": 1,', new_text: '"a": 1' }],
        },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toContain('代码完整性警告');
      expect(result.output).toContain('JSON 格式错误');
      expect(result.output).toContain('问题:');
      // 警告追加在 output 末尾，收尾建议指向再次 Edit 修复
      expect(result.output.trimEnd().endsWith('或重新生成完整文件。')).toBe(true);
      expect(result.output).toContain('请再次使用 Edit 工具');
      expect(result.meta?.completenessIssues).toEqual(
        expect.arrayContaining([expect.stringContaining('JSON 格式错误')]),
      );
      expect(result.meta?.artifact).toMatchObject({
        metadata: {
          completenessIssues: expect.arrayContaining([
            expect.stringContaining('JSON 格式错误'),
          ]),
        },
      });
      // 不回滚：磁盘上是编辑后的（坏）内容
      expect(await fs.readFile(file, 'utf-8')).toBe('{\n  "a": 1\n  "b": 2\n}\n');
    });

    it('stays silent on valid edits to .json and .ts files', async () => {
      const jsonFile = path.join(tmpDir, 'ok.json');
      await fs.writeFile(jsonFile, '{\n  "a": 1,\n  "b": 2\n}\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(jsonFile);
      const tsFile = path.join(tmpDir, 'ok.ts');
      await fs.writeFile(tsFile, 'export function foo(): number {\n  return 1;\n}\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(tsFile);

      const handler = await editModule.createHandler();
      const jsonResult = await handler.execute(
        { file_path: jsonFile, edits: [{ old_text: '"b": 2', new_text: '"b": 3' }] },
        makeCtx(),
        allowAll,
      );
      const tsResult = await handler.execute(
        { file_path: tsFile, edits: [{ old_text: 'return 1;', new_text: 'return 2;' }] },
        makeCtx(),
        allowAll,
      );

      for (const result of [jsonResult, tsResult]) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.output).not.toContain('代码完整性警告');
        expect(result.meta?.completenessIssues).toBeUndefined();
      }
      expect(await fs.readFile(jsonFile, 'utf-8')).toBe('{\n  "a": 1,\n  "b": 3\n}\n');
      expect(await fs.readFile(tsFile, 'utf-8')).toBe('export function foo(): number {\n  return 2;\n}\n');
    });

    it('does not check non-code extensions (.md)', async () => {
      const file = path.join(tmpDir, 'notes.md');
      await fs.writeFile(file, 'before\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(file);

      const handler = await editModule.createHandler();
      const result = await handler.execute(
        // 编辑后内容「看起来坏了」（未闭合括号 + 非法 JSON），但 .md 不在检测范围
        { file_path: file, edits: [{ old_text: 'before', new_text: "{'unclosed': true" }] },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).not.toContain('代码完整性警告');
        expect(result.meta?.completenessIssues).toBeUndefined();
      }
    });

    it('stays silent when the issues already existed before the edit (noise guard)', async () => {
      const file = path.join(tmpDir, 'already-broken.json');
      await fs.writeFile(file, '{"a": 1\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(file);

      const handler = await editModule.createHandler();
      const result = await handler.execute(
        // 无害编辑：文件编辑前后同样不完整，问题串逐条相同 → 不重复报警
        { file_path: file, edits: [{ old_text: '"a": 1', new_text: '"a": 2' }] },
        makeCtx(),
        allowAll,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).not.toContain('代码完整性警告');
        expect(result.meta?.completenessIssues).toBeUndefined();
      }
      expect(await fs.readFile(file, 'utf-8')).toBe('{"a": 2\n');
    });
  });
});
