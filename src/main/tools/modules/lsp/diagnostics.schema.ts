// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time, so it can be
// eager-imported by modules/index.ts without inflating the dependency graph.
import type { ToolSchema } from '../../../protocol/tools';

export const DIAGNOSTICS_DESCRIPTION = `Query LSP diagnostics (errors/warnings) for a file or the entire project.

Use this tool to:
- Check for compilation errors after edits
- Get all project-wide errors and warnings
- Verify code correctness before committing

Parameters:
- file_path (optional): Specific file to check. If omitted, returns all project diagnostics.
- severity_filter: Filter by severity - 'error', 'warning', or 'all' (default: 'all')

Note: Requires LSP servers to be running for the relevant file types.`;

export const DIAGNOSTICS_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    file_path: {
      type: 'string',
      description: 'Optional file path to check. If omitted, returns all project diagnostics.',
    },
    severity_filter: {
      type: 'string',
      enum: ['error', 'warning', 'all'],
      description: 'Filter diagnostics by severity. Default: all',
    },
  },
  required: [],
};

export const diagnosticsSchema: ToolSchema = {
  name: 'diagnostics',
  description: DIAGNOSTICS_DESCRIPTION,
  inputSchema: DIAGNOSTICS_INPUT_SCHEMA,
  category: 'lsp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
