// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const jiraSchema: ToolSchema = {
  name: 'jira',
  description: `Jira 问题管理：查询、获取、创建 Issue。

需要配置环境变量或设置：
- JIRA_BASE_URL: Jira 实例 URL (如 https://your-domain.atlassian.net)
- JIRA_EMAIL: 登录邮箱
- JIRA_API_TOKEN: API Token (从 https://id.atlassian.com/manage-profile/security/api-tokens 获取)

**使用示例：**

查询 Issue：
\`\`\`
jira { "action": "query", "project": "PROJ", "status": "In Progress" }
jira { "action": "query", "jql": "assignee = currentUser() AND status != Done" }
\`\`\`

获取单个 Issue：
\`\`\`
jira { "action": "get", "issue_key": "PROJ-123" }
\`\`\`

创建 Issue：
\`\`\`
jira {
  "action": "create",
  "project": "PROJ",
  "summary": "修复登录页面 Bug",
  "description": "用户反馈登录按钮点击无响应",
  "issue_type": "Bug",
  "priority": "High"
}
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['query', 'create', 'get'],
        description: '操作类型',
      },
      jql: {
        type: 'string',
        description: 'JQL 查询语句（action=query 时使用）',
      },
      project: {
        type: 'string',
        description: '项目 Key（如 PROJ）',
      },
      status: {
        type: 'string',
        description: 'Issue 状态筛选',
      },
      assignee: {
        type: 'string',
        description: '指派人筛选',
      },
      max_results: {
        type: 'number',
        description: '最大返回数量（默认: 20）',
      },
      issue_key: {
        type: 'string',
        description: 'Issue Key（action=get 时使用）',
      },
      summary: {
        type: 'string',
        description: 'Issue 标题（action=create 时使用）',
      },
      description: {
        type: 'string',
        description: 'Issue 描述（action=create 时使用）',
      },
      issue_type: {
        type: 'string',
        description: 'Issue 类型：Bug, Task, Story, Epic（默认: Task）',
      },
      priority: {
        type: 'string',
        description: '优先级：Highest, High, Medium, Low, Lowest',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表',
      },
    },
    required: ['action'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
