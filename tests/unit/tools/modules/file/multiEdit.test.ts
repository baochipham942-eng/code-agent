import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/main/protocol/tools';
import { fileReadTracker } from '../../../../../src/main/tools/fileReadTracker';

vi.mock('../../../../../src/main/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

import { editModule } from '../../../../../src/main/tools/modules/file/multiEdit';

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
});
