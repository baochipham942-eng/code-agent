// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const gitDiffSchema: ToolSchema = {
  name: 'git_diff',
  description: `Git 差异分析工具。查看未暂存/已暂存/跨分支差异和特定提交内容。

操作类型: diff (未暂存) | diff_staged (已暂存) | diff_branch (跨分支) | show (特定提交)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['diff', 'diff_staged', 'diff_branch', 'show'] },
      files: { type: 'array', items: { type: 'string' } },
      stat_only: { type: 'boolean' },
      base: { type: 'string' },
      head: { type: 'string' },
      commit: { type: 'string' },
    },
    required: ['action'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: true, // diff 是只读操作
  allowInPlanMode: true,
};
