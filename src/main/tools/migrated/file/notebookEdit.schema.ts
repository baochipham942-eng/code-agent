// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const notebookEditSchema: ToolSchema = {
  name: 'notebook_edit',
  description: `Edit Jupyter Notebook (.ipynb) cells.

Completely replaces the contents of a specific cell in a Jupyter notebook with new source.
Edit modes: replace (default) | insert | delete.`,
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file' },
      cell_id: { type: 'string', description: 'Cell ID or numeric index (default: 0)' },
      new_source: { type: 'string', description: 'New source content' },
      cell_type: { type: 'string', enum: ['code', 'markdown'] },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
    },
    required: ['notebook_path', 'new_source'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
