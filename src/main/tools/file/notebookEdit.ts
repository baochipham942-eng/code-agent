// ============================================================================
// NotebookEdit Tool - Edit Jupyter Notebook cells
// ============================================================================
// Features:
// - Support replace, insert, delete edit modes
// - Auto clear cell outputs (for code cells)
// - Jupyter notebook format validation
// - Enhanced error handling and path validation
// - Preserve cell metadata
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Tool Definition
// ----------------------------------------------------------------------------

export const notebookEditTool: Tool = {
  name: 'notebook_edit',
  description: `Edit Jupyter Notebook (.ipynb) cells.

Completely replaces the contents of a specific cell in a Jupyter notebook with new source.
Jupyter notebooks are interactive documents that combine code, text, and visualizations,
commonly used for data analysis and scientific computing.

Usage:
- notebook_path: Absolute path to the .ipynb file (required)
- cell_id: Cell ID or index to edit (optional, defaults to 0)
- new_source: The new content for the cell (required)
- cell_type: 'code' or 'markdown' (optional, defaults to current type)
- edit_mode: 'replace', 'insert', or 'delete' (optional, defaults to 'replace')

Edit modes:
- replace: Replace the specified cell's content
- insert: Add a new cell after the specified cell_id
- delete: Remove the specified cell

Examples:
- Replace cell 0: { "notebook_path": "/path/to/nb.ipynb", "new_source": "print('hello')" }
- Insert after cell 2: { "notebook_path": "/path/to/nb.ipynb", "cell_id": "2", "new_source": "# New markdown", "cell_type": "markdown", "edit_mode": "insert" }
- Delete cell: { "notebook_path": "/path/to/nb.ipynb", "cell_id": "3", "new_source": "", "edit_mode": "delete" }`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',

  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: {
        type: 'string',
        description:
          'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
      },
      cell_id: {
        type: 'string',
        description:
          'The ID of the cell to edit, or a numeric index (0-based). ' +
          'When inserting a new cell, the new cell will be inserted after the cell with this ID. ' +
          'If not specified, defaults to cell 0.',
      },
      new_source: {
        type: 'string',
        description: 'The new source content for the cell',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description:
          'The type of the cell (code or markdown). ' +
          'If not specified, defaults to the current cell type. ' +
          'Required when using edit_mode=insert.',
      },
      edit_mode: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description:
          'The type of edit to make (replace, insert, delete). Defaults to replace.',
      },
    },
    required: ['notebook_path', 'new_source'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const notebookPath = params.notebook_path as string;
    const cellId = params.cell_id as string | undefined;
    const newSource = params.new_source as string;
    const cellType = params.cell_type as 'code' | 'markdown' | undefined;
    const editMode = (params.edit_mode as 'replace' | 'insert' | 'delete') || 'replace';

    try {
      // Validate path is absolute
      if (!path.isAbsolute(notebookPath)) {
        return {
          success: false,
          error: `notebook_path must be an absolute path, got: ${notebookPath}`,
        };
      }

      // Resolve path
      const resolvedPath = resolvePath(notebookPath, context.workingDirectory);

      // Check file extension
      if (!resolvedPath.endsWith('.ipynb')) {
        return {
          success: false,
          error: `File must be a Jupyter notebook (.ipynb), got: ${path.extname(resolvedPath)}`,
        };
      }

      // Read and parse notebook
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            success: false,
            error: `Notebook file not found: ${resolvedPath}`,
          };
        }
        throw err;
      }

      let notebook: NotebookContent;
      try {
        notebook = JSON.parse(content);
      } catch (parseError) {
        return {
          success: false,
          error: `Failed to parse notebook JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }

      // Validate notebook format
      const validationError = validateNotebookFormat(notebook);
      if (validationError) {
        return { success: false, error: validationError };
      }

      // Find target cell index
      let cellIndex: number;
      if (!cellId) {
        cellIndex = 0;
      } else {
        cellIndex = findCellIndex(notebook.cells, cellId);

        if (cellIndex === -1) {
          if (editMode === 'insert') {
            return {
              success: false,
              error: `Cell with ID "${cellId}" not found in notebook.`,
            };
          }
          return {
            success: false,
            error: `Cell not found with ID: ${cellId}. Available cells: ${notebook.cells.length}`,
          };
        }

        // For insert mode, insert after the found cell
        if (editMode === 'insert') {
          cellIndex = cellIndex + 1;
        }
      }

      // Delete mode requires cell_id
      if (editMode === 'delete' && !cellId) {
        return {
          success: false,
          error: 'cell_id is required for delete mode',
        };
      }

      // Execute edit operation
      let resultMessage = '';
      let actualEditMode = editMode;

      // Special handling: if replace index out of range, auto convert to insert
      if (actualEditMode === 'replace' && cellIndex >= notebook.cells.length) {
        actualEditMode = 'insert';
      }

      switch (actualEditMode) {
        case 'replace': {
          if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
            return {
              success: false,
              error: `Cell index out of range: ${cellIndex} (total cells: ${notebook.cells.length})`,
            };
          }

          const cell = notebook.cells[cellIndex];
          const oldType = cell.cell_type;

          // Update source
          cell.source = newSource;

          // Update cell type if specified
          if (cellType) {
            cell.cell_type = cellType;
          }

          // Clear outputs for code cells
          clearCellOutputs(cell);

          resultMessage = `Replaced cell ${cellIndex}${
            oldType !== cell.cell_type ? ` (changed type from ${oldType} to ${cell.cell_type})` : ''
          }`;
          break;
        }

        case 'insert': {
          const finalCellType = cellType || 'code';

          const newCell: NotebookCell = {
            cell_type: finalCellType,
            source: newSource,
            metadata: {},
          };

          // Initialize code cell outputs
          if (finalCellType === 'code') {
            newCell.outputs = [];
            newCell.execution_count = null;
          }

          // Generate ID for nbformat 4.5+
          if (
            notebook.nbformat > 4 ||
            (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
          ) {
            newCell.id = generateCellId();
          }

          notebook.cells.splice(cellIndex, 0, newCell);
          resultMessage = `Inserted new ${finalCellType} cell at position ${cellIndex}`;
          break;
        }

        case 'delete': {
          if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
            return {
              success: false,
              error: `Cell index out of range: ${cellIndex} (total cells: ${notebook.cells.length})`,
            };
          }

          const deletedCell = notebook.cells[cellIndex];
          notebook.cells.splice(cellIndex, 1);

          resultMessage = `Deleted ${deletedCell.cell_type} cell at position ${cellIndex} (${notebook.cells.length} cells remaining)`;
          break;
        }

        default:
          return {
            success: false,
            error: `Invalid edit_mode: ${editMode}. Must be 'replace', 'insert', or 'delete'`,
          };
      }

      // Write back with pretty JSON (1 space indent, matching Claude Code)
      await fs.writeFile(resolvedPath, JSON.stringify(notebook, null, 1) + '\n', 'utf-8');

      return {
        success: true,
        output: `${resultMessage} in ${path.basename(resolvedPath)}`,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to edit notebook: ${errorMessage}`,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * Validate Jupyter notebook format
 */
function validateNotebookFormat(notebook: any): string | null {
  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    return 'Invalid notebook structure: missing or invalid cells array';
  }

  if (typeof notebook.nbformat !== 'number') {
    return 'Invalid notebook structure: missing or invalid nbformat';
  }

  if (typeof notebook.nbformat_minor !== 'number') {
    return 'Invalid notebook structure: missing or invalid nbformat_minor';
  }

  // Validate version (support v4.x)
  if (notebook.nbformat < 4) {
    return `Unsupported notebook format version: ${notebook.nbformat}.${notebook.nbformat_minor} (only v4.x is supported)`;
  }

  if (!notebook.metadata || typeof notebook.metadata !== 'object') {
    return 'Invalid notebook structure: missing or invalid metadata';
  }

  // Validate each cell
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

    // Auto-fix code cells without outputs
    if (cell.cell_type === 'code') {
      if (!Array.isArray(cell.outputs)) {
        cell.outputs = [];
      }
      if (cell.execution_count === undefined) {
        cell.execution_count = null;
      }
    }
  }

  return null;
}

/**
 * Find cell index by ID or numeric index
 */
function findCellIndex(cells: NotebookCell[], cellId: string): number {
  // Try exact ID match first
  const indexById = cells.findIndex((c) => c.id === cellId);
  if (indexById !== -1) {
    return indexById;
  }

  // Try parsing as numeric index
  const numIndex = parseInt(cellId, 10);
  if (!isNaN(numIndex)) {
    // Support negative index (from end)
    if (numIndex < 0) {
      const positiveIndex = cells.length + numIndex;
      if (positiveIndex >= 0 && positiveIndex < cells.length) {
        return positiveIndex;
      }
    } else if (numIndex >= 0 && numIndex < cells.length) {
      return numIndex;
    }
  }

  return -1;
}

/**
 * Clear cell outputs (for code cells only)
 */
function clearCellOutputs(cell: NotebookCell): void {
  if (cell.cell_type === 'code') {
    cell.outputs = [];
    cell.execution_count = null;
  }
}

/**
 * Generate unique cell ID (8 random alphanumeric characters)
 */
function generateCellId(): string {
  return crypto.randomUUID().split('-')[0];
}
