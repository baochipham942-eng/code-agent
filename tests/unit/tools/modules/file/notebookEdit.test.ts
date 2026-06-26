import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';
import { notebookEditModule } from '../../../../../src/host/tools/modules/file/notebookEdit';

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

describe('notebookEditModule evidence metadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-edit-evidence-'));
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
});
