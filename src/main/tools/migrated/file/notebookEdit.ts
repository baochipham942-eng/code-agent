// ============================================================================
// NotebookEdit (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/file/notebookEdit.ts (registered as 'notebook_edit')
// 改造点：
// - 4 参数签名
// - canUseTool 真权限闸门
// - 输出格式与 legacy 字节级一致
// - 无外部业务依赖（fs + path + crypto.randomUUID）
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { notebookEditSchema as schema } from './notebookEdit.schema';

interface NotebookCell {
  id?: string;
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface NotebookContent {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function validateNotebookFormat(notebook: NotebookContent): string | null {
  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    return 'Invalid notebook structure: missing or invalid cells array';
  }
  if (typeof notebook.nbformat !== 'number') {
    return 'Invalid notebook structure: missing or invalid nbformat';
  }
  if (typeof notebook.nbformat_minor !== 'number') {
    return 'Invalid notebook structure: missing or invalid nbformat_minor';
  }
  if (notebook.nbformat < 4) {
    return `Unsupported notebook format version: ${notebook.nbformat}.${notebook.nbformat_minor} (only v4.x is supported)`;
  }
  if (!notebook.metadata || typeof notebook.metadata !== 'object') {
    return 'Invalid notebook structure: missing or invalid metadata';
  }
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i];
    if (!cell.cell_type || typeof cell.cell_type !== 'string') {
      return `Invalid cell at index ${i}: missing or invalid cell_type`;
    }
    if (!['code', 'markdown', 'raw'].includes(cell.cell_type)) {
      return `Invalid cell at index ${i}: unknown cell_type '${cell.cell_type}'`;
    }
    if (cell.source === undefined) {
      return `Invalid cell at index ${i}: missing source`;
    }
    if (cell.cell_type === 'code') {
      if (!Array.isArray(cell.outputs)) cell.outputs = [];
      if (cell.execution_count === undefined) cell.execution_count = null;
    }
  }
  return null;
}

function findCellIndex(cells: NotebookCell[], cellId: string): number {
  const indexById = cells.findIndex((c) => c.id === cellId);
  if (indexById !== -1) return indexById;

  const numIndex = parseInt(cellId, 10);
  if (!isNaN(numIndex)) {
    if (numIndex < 0) {
      const positiveIndex = cells.length + numIndex;
      if (positiveIndex >= 0 && positiveIndex < cells.length) return positiveIndex;
    } else if (numIndex >= 0 && numIndex < cells.length) {
      return numIndex;
    }
  }
  return -1;
}

function clearCellOutputs(cell: NotebookCell): void {
  if (cell.cell_type === 'code') {
    cell.outputs = [];
    cell.execution_count = null;
  }
}

function generateCellId(): string {
  return crypto.randomUUID().split('-')[0];
}

class NotebookEditHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const notebookPath = args.notebook_path as string | undefined;
    const cellId = args.cell_id as string | undefined;
    const newSource = args.new_source as string | undefined;
    const cellType = args.cell_type as 'code' | 'markdown' | undefined;
    const editMode = (args.edit_mode as 'replace' | 'insert' | 'delete' | undefined) ?? 'replace';

    if (!notebookPath || typeof notebookPath !== 'string') {
      return { ok: false, error: 'notebook_path 必须是字符串', code: 'INVALID_ARGS' };
    }
    if (typeof newSource !== 'string') {
      return { ok: false, error: 'new_source 必须是字符串', code: 'INVALID_ARGS' };
    }
    if (!path.isAbsolute(notebookPath)) {
      return { ok: false, error: `notebook_path must be an absolute path, got: ${notebookPath}`, code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const resolvedPath = notebookPath;
    if (!resolvedPath.endsWith('.ipynb')) {
      return { ok: false, error: `File must be a Jupyter notebook (.ipynb), got: ${path.extname(resolvedPath)}`, code: 'INVALID_EXT' };
    }

    onProgress?.({ stage: 'starting', detail: `notebook ${editMode}` });

    let raw: string;
    try {
      raw = await fs.readFile(resolvedPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, error: `Notebook file not found: ${resolvedPath}`, code: 'ENOENT' };
      }
      return { ok: false, error: e.message, code: 'READ_ERROR' };
    }

    let notebook: NotebookContent;
    try {
      notebook = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to parse notebook JSON: ${msg}`, code: 'PARSE_ERROR' };
    }

    const validationError = validateNotebookFormat(notebook);
    if (validationError) {
      return { ok: false, error: validationError, code: 'INVALID_NOTEBOOK' };
    }

    let cellIndex: number;
    if (!cellId) {
      cellIndex = 0;
    } else {
      cellIndex = findCellIndex(notebook.cells, cellId);
      if (cellIndex === -1) {
        return {
          ok: false,
          error: `Cell not found with ID: ${cellId}. Available cells: ${notebook.cells.length}`,
          code: 'CELL_NOT_FOUND',
        };
      }
      if (editMode === 'insert') {
        cellIndex = cellIndex + 1;
      }
    }

    if (editMode === 'delete' && !cellId) {
      return { ok: false, error: 'cell_id is required for delete mode', code: 'INVALID_ARGS' };
    }

    let actualEditMode = editMode;
    if (actualEditMode === 'replace' && cellIndex >= notebook.cells.length) {
      actualEditMode = 'insert';
    }

    let resultMessage = '';
    switch (actualEditMode) {
      case 'replace': {
        if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
          return { ok: false, error: `Cell index out of range: ${cellIndex}`, code: 'OUT_OF_RANGE' };
        }
        const cell = notebook.cells[cellIndex];
        const oldType = cell.cell_type;
        cell.source = newSource;
        if (cellType) cell.cell_type = cellType;
        clearCellOutputs(cell);
        resultMessage = `Replaced cell ${cellIndex}${
          oldType !== cell.cell_type ? ` (changed type from ${oldType} to ${cell.cell_type})` : ''
        }`;
        break;
      }
      case 'insert': {
        const finalCellType = cellType ?? 'code';
        const newCell: NotebookCell = {
          cell_type: finalCellType,
          source: newSource,
          metadata: {},
        };
        if (finalCellType === 'code') {
          newCell.outputs = [];
          newCell.execution_count = null;
        }
        if (notebook.nbformat > 4 || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)) {
          newCell.id = generateCellId();
        }
        notebook.cells.splice(cellIndex, 0, newCell);
        resultMessage = `Inserted new ${finalCellType} cell at position ${cellIndex}`;
        break;
      }
      case 'delete': {
        if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
          return { ok: false, error: `Cell index out of range: ${cellIndex}`, code: 'OUT_OF_RANGE' };
        }
        const deletedCell = notebook.cells[cellIndex];
        notebook.cells.splice(cellIndex, 1);
        resultMessage = `Deleted ${deletedCell.cell_type} cell at position ${cellIndex} (${notebook.cells.length} cells remaining)`;
        break;
      }
    }

    try {
      await fs.writeFile(resolvedPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');
    } catch (err) {
      const e = err as Error;
      return { ok: false, error: `write failed: ${e.message}`, code: 'WRITE_ERROR' };
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('NotebookEdit done', { resolvedPath, mode: actualEditMode });

    return { ok: true, output: `${resultMessage} in ${path.basename(resolvedPath)}` };
  }
}

export const notebookEditModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new NotebookEditHandler();
  },
};
