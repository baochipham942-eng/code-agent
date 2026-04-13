// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const githubPrSchema: ToolSchema = {
  name: 'github_pr',
  description: `GitHub Pull Request 管理工具。创建、查看、列出、评论、审查和合并 PR。

**前置条件**: 需要安装 gh CLI 并完成登录 (brew install gh && gh auth login)。
工作目录必须是 Git 仓库。

**何时使用**: 需要与 GitHub PR 交互时 — 创建新 PR、查看 PR 详情、列出仓库 PR、添加评论或 review、合并 PR。
**何时不用**: 仅需查看本地 Git 信息（用 bash + git 命令）、操作 GitHub Issues（用 bash + gh issue）。

**使用示例**:

创建 PR（自动检测分支、推送、生成标题）:
\`\`\`
github_pr { "action": "create" }
github_pr { "action": "create", "title": "Add login feature", "base": "develop", "draft": true }
\`\`\`

查看 PR:
\`\`\`
github_pr { "action": "view", "pr": 42 }
github_pr { "action": "view", "pr": "https://github.com/owner/repo/pull/42" }
\`\`\`

列出 PR:
\`\`\`
github_pr { "action": "list" }
github_pr { "action": "list", "state": "closed", "author": "octocat", "limit": 5 }
\`\`\`

评论 PR:
\`\`\`
github_pr { "action": "comment", "pr": 42, "body": "LGTM!" }
\`\`\`

Review PR:
\`\`\`
github_pr { "action": "review", "pr": 42, "event": "approve", "body": "Looks good" }
\`\`\`

合并 PR（需要二次确认）:
\`\`\`
github_pr { "action": "merge", "pr": 42, "method": "squash", "delete_branch": true }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'view', 'list', 'comment', 'review', 'merge'],
        description: '操作类型',
      },
      title: {
        type: 'string',
        description: 'PR 标题（action=create, 不提供则从 commit 生成）',
      },
      body: {
        type: 'string',
        description: 'PR 描述或评论内容（action=create/comment/review）',
      },
      base: {
        type: 'string',
        description: '目标分支（action=create, 默认自动检测 main/master）',
      },
      draft: {
        type: 'boolean',
        description: '是否创建为 Draft PR（action=create）',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表（action=create）',
      },
      pr: {
        type: 'string',
        description: 'PR 编号或 URL（action=view/comment/review/merge）',
      },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'merged', 'all'],
        description: 'PR 状态筛选（action=list, 默认 open）',
      },
      author: {
        type: 'string',
        description: '作者筛选（action=list）',
      },
      label: {
        type: 'string',
        description: '标签筛选（action=list）',
      },
      limit: {
        type: 'number',
        description: '最大返回数量（action=list, 默认 10）',
      },
      event: {
        type: 'string',
        enum: ['approve', 'request-changes', 'comment'],
        description: 'Review 类型（action=review, 默认 comment）',
      },
      method: {
        type: 'string',
        enum: ['merge', 'squash', 'rebase'],
        description: '合并方式（action=merge, 默认 merge）',
      },
      delete_branch: {
        type: 'boolean',
        description: '合并后是否删除远程分支（action=merge）',
      },
    },
    required: ['action'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
