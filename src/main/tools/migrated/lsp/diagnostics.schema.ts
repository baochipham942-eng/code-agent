// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { diagnosticsTool } from '../../lsp/diagnostics';

export const diagnosticsSchema: ToolSchema = {
  name: 'diagnostics',
  description: diagnosticsTool.description,
  inputSchema: diagnosticsTool.inputSchema,
  category: 'lsp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
