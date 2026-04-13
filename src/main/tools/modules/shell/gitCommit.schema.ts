// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const gitCommitSchema: ToolSchema = {
  name: 'git_commit',
  description: `Git 提交管理工具。查看状态、暂存文件、提交、推送和查看日志。

操作类型: status | add | commit | push | log`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'add', 'commit', 'push', 'log'] },
      files: { type: 'array', items: { type: 'string' } },
      all: { type: 'boolean' },
      message: { type: 'string' },
      amend: { type: 'boolean' },
      remote: { type: 'string' },
      branch: { type: 'string' },
      set_upstream: { type: 'boolean' },
      limit: { type: 'number' },
      oneline: { type: 'boolean' },
    },
    required: ['action'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
