// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const gitWorktreeSchema: ToolSchema = {
  name: 'git_worktree',
  description: `Git 工作树管理工具。创建、列出、删除和清理工作树。

操作类型: list | add | remove | prune`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'prune'] },
      path: { type: 'string' },
      branch: { type: 'string' },
      new_branch: { type: 'string' },
      base: { type: 'string' },
      force: { type: 'boolean' },
    },
    required: ['action'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
