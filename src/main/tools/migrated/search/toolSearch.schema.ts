// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { toolSearchTool } from '../../search/toolSearch';

export const toolSearchSchema: ToolSchema = {
  name: 'ToolSearch',
  description: toolSearchTool.description,
  inputSchema: toolSearchTool.inputSchema,
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
