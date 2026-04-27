// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time, so it can be
// eager-imported by modules/index.ts without inflating the dependency graph.
import type { ToolSchema } from '../../../protocol/tools';

export const TOOL_SEARCH_DESCRIPTION = `Searches for or selects deferred tools. Callable deferred tools are loaded before use; search-only hits are returned with not-callable reasons and must be treated as context, not direct tool calls.`;

export const TOOL_SEARCH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description: '搜索查询。支持关键字、"select:工具名" 或 "+必须词 关键字"',
    },
    max_results: {
      type: 'number',
      description: '最大返回结果数（默认 5，最大 10）',
    },
  },
  required: ['query'],
};

export const toolSearchSchema: ToolSchema = {
  name: 'ToolSearch',
  description: TOOL_SEARCH_DESCRIPTION,
  inputSchema: TOOL_SEARCH_INPUT_SCHEMA,
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
