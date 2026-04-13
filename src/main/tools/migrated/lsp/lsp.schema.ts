// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { lspTool } from '../../lsp/lsp';

export const lspSchema: ToolSchema = {
  name: 'lsp',
  description: lspTool.description,
  inputSchema: lspTool.inputSchema,
  category: 'lsp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
