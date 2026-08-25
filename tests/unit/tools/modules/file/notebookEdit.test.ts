import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const notebookWriteState = vi.hoisted(() => ({
  trackPath: undefined as string | undefined,
  blockedContent: undefined as string | undefined,
  calls: 0,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const writeFile = async (...args: Parameters<typeof actual.writeFile>) => {
    if (args[0] === notebookWriteState.trackPath) {
      notebookWriteState.calls += 1;
      if (notebookWriteState.blockedContent && String(args[1]).includes(notebookWriteState.blockedContent)) {
        notebookWriteState.entered?.();
        await notebookWriteState.release;
      }
    }
    return actual.writeFile(...args);
  };
  return {
    ...actual,
    default: { ...actual, writeFile },
    writeFile,
  };
});

import { notebookEditModule } from '../../../../../src/host/tools/modules/file/notebookEdit';

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
  } as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('notebookEditModule evidence metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-edit-evidence-'));
    notebookWriteState.trackPath = undefined;
    notebookWriteState.blockedContent = undefined;
    notebookWriteState.calls = 0;
    notebookWriteState.entered = undefined;
    notebookWriteState.release = undefined;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns changedFiles and notebook artifact after replacing a cell', async () => {
    const file = path.join(tmpDir, 'analysis.ipynb');
    await fs.writeFile(
      file,
      JSON.stringify({
        cells: [
          { id: 'cell-a', cell_type: 'code', source: 'x = 1', metadata: {}, outputs: [], execution_count: 1 },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      'utf-8',
    );

    const handler = await notebookEditModule.createHandler();
    const result = await handler.execute(
      {
        notebook_path: file,
        cell_id: 'cell-a',
        new_source: 'x = 2',
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        action: 'replace',
        operation: 'notebook_edit',
        path: file,
        changedFiles: [file],
        cellIndex: 0,
        cellCount: 1,
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'notebook_edit',
        path: file,
        metadata: {
          action: 'replace',
          operation: 'notebook_edit',
        },
      });
    }
  });

  it('serializes sibling agents so edits to different cells are both preserved', async () => {
    const file = path.join(tmpDir, 'concurrent.ipynb');
    await fs.writeFile(
      file,
      JSON.stringify({
        cells: [
          { id: 'cell-a', cell_type: 'code', source: 'a = 0', metadata: {}, outputs: [], execution_count: null },
          { id: 'cell-b', cell_type: 'code', source: 'b = 0', metadata: {}, outputs: [], execution_count: null },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      'utf-8',
    );

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    notebookWriteState.trackPath = file;
    notebookWriteState.blockedContent = 'a = 1';
    notebookWriteState.entered = markFirstEntered;
    notebookWriteState.release = firstMayFinish;

    try {
      const firstHandler = await notebookEditModule.createHandler();
      const secondHandler = await notebookEditModule.createHandler();
      const first = firstHandler.execute(
        { notebook_path: file, cell_id: 'cell-a', new_source: 'a = 1' },
        makeCtx({ agentId: 'agent-a' }),
        allowAll,
      );
      await firstEntered;

      const second = secondHandler.execute(
        { notebook_path: file, cell_id: 'cell-b', new_source: 'b = 1' },
        makeCtx({ agentId: 'agent-b' }),
        allowAll,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(notebookWriteState.calls).toBe(1);

      releaseFirst();
      expect((await first).ok).toBe(true);
      expect((await second).ok).toBe(true);
      const notebook = JSON.parse(await fs.readFile(file, 'utf-8')) as { cells: Array<{ source: string }> };
      expect(notebook.cells.map((cell) => cell.source)).toEqual(['a = 1', 'b = 1']);
    } finally {
      releaseFirst();
    }
  });

  it('fails loudly when agent identity is unavailable', async () => {
    const file = path.join(tmpDir, 'missing-agent.ipynb');
    await fs.writeFile(file, '{}', 'utf-8');
    const handler = await notebookEditModule.createHandler();
    const result = await handler.execute(
      { notebook_path: file, new_source: 'x = 1' },
      makeCtx({ agentId: undefined }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_AGENT_IDENTITY');
  });
});
