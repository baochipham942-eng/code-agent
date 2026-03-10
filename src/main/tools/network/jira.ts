// ============================================================================
// Jira Tool - Jira 查询和创建
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('Jira');

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

interface JiraQueryParams {
  action: 'query' | 'create' | 'get';
  // query
  jql?: string;
  project?: string;
  status?: string;
  assignee?: string;
  max_results?: number;
  // get
  issue_key?: string;
  // create
  summary?: string;
  description?: string;
  issue_type?: string;
  priority?: string;
  labels?: string[];
}

/**
 * 获取 Jira 配置
 */
function getJiraConfig(): JiraConfig | null {
  // 优先从环境变量读取
  const envBaseUrl = process.env.JIRA_BASE_URL;
  const envEmail = process.env.JIRA_EMAIL;
  const envApiToken = process.env.JIRA_API_TOKEN;

  if (envBaseUrl && envEmail && envApiToken) {
    return { baseUrl: envBaseUrl, email: envEmail, apiToken: envApiToken };
  }

  // 从设置中读取（secureStorage）
  const configService = getConfigService();
  const integration = configService.getIntegration('jira');

  if (integration?.baseUrl && integration?.email && integration?.apiToken) {
    return {
      baseUrl: integration.baseUrl,
      email: integration.email,
      apiToken: integration.apiToken,
    };
  }

  return null;
}

/**
 * 调用 Jira API
 */
async function callJiraApi(
  config: JiraConfig,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<Response> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

  return fetch(`${config.baseUrl}/rest/api/3${endpoint}`, {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * 格式化 Issue 为可读文本
 */
function formatIssue(issue: any): string {
  const fields = issue.fields || {};
  return `**${issue.key}**: ${fields.summary || '(无标题)'}
  状态: ${fields.status?.name || '未知'}
  类型: ${fields.issuetype?.name || '未知'}
  优先级: ${fields.priority?.name || '未知'}
  指派: ${fields.assignee?.displayName || '未分配'}
  创建: ${fields.created ? new Date(fields.created).toLocaleDateString() : '未知'}`;
}

export const jiraTool: Tool = {
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
  requiresPermission: true,
  permissionLevel: 'network',
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
        default: 20,
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
        default: 'Task',
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

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      action,
      jql,
      project,
      status,
      assignee,
      max_results = 20,
      issue_key,
      summary,
      description,
      issue_type = 'Task',
      priority,
      labels,
    } = params as unknown as JiraQueryParams;

    // 检查配置
    const config = getJiraConfig();
    if (!config) {
      return {
        success: false,
        error: `Jira 未配置。请设置以下环境变量：
- JIRA_BASE_URL: Jira 实例 URL
- JIRA_EMAIL: 登录邮箱
- JIRA_API_TOKEN: API Token

或在设置中配置 jira.baseUrl, jira.email, jira.apiToken`,
      };
    }

    try {
      // ==================== 查询 ====================
      if (action === 'query') {
        let queryJql = jql;

        // 如果没有 JQL，根据参数构建
        if (!queryJql) {
          const conditions: string[] = [];
          if (project) conditions.push(`project = "${project}"`);
          if (status) conditions.push(`status = "${status}"`);
          if (assignee) conditions.push(`assignee = "${assignee}"`);
          queryJql = conditions.length > 0 ? conditions.join(' AND ') : 'ORDER BY created DESC';
        }

        context.emit?.('tool_output', {
          tool: 'jira',
          message: `🔍 正在查询: ${queryJql}`,
        });

        const response = await callJiraApi(
          config,
          'GET',
          `/search?jql=${encodeURIComponent(queryJql)}&maxResults=${max_results}`
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`查询失败: ${error}`);
        }

        const data = await response.json();
        const issues = data.issues || [];

        if (issues.length === 0) {
          return {
            success: true,
            output: '未找到匹配的 Issue',
          };
        }

        let output = `📋 找到 ${issues.length} 个 Issue (共 ${data.total} 个)\n\n`;
        output += issues.map((issue: any) => formatIssue(issue)).join('\n\n');

        return {
          success: true,
          output,
          metadata: {
            total: data.total,
            returned: issues.length,
            issues: issues.map((i: any) => ({ key: i.key, summary: i.fields?.summary })),
          },
        };
      }

      // ==================== 获取单个 ====================
      if (action === 'get') {
        if (!issue_key) {
          return { success: false, error: '缺少 issue_key 参数' };
        }

        context.emit?.('tool_output', {
          tool: 'jira',
          message: `📄 正在获取: ${issue_key}`,
        });

        const response = await callJiraApi(config, 'GET', `/issue/${issue_key}`);

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`获取失败: ${error}`);
        }

        const issue = await response.json();
        const fields = issue.fields || {};

        let output = `📄 ${issue.key}: ${fields.summary}\n\n`;
        output += `**状态**: ${fields.status?.name || '未知'}\n`;
        output += `**类型**: ${fields.issuetype?.name || '未知'}\n`;
        output += `**优先级**: ${fields.priority?.name || '未知'}\n`;
        output += `**指派**: ${fields.assignee?.displayName || '未分配'}\n`;
        output += `**报告人**: ${fields.reporter?.displayName || '未知'}\n`;
        output += `**创建时间**: ${fields.created || '未知'}\n`;
        output += `**更新时间**: ${fields.updated || '未知'}\n`;

        if (fields.labels?.length > 0) {
          output += `**标签**: ${fields.labels.join(', ')}\n`;
        }

        if (fields.description) {
          output += `\n**描述**:\n${typeof fields.description === 'string' ? fields.description : JSON.stringify(fields.description, null, 2)}`;
        }

        return {
          success: true,
          output,
          metadata: { issue },
        };
      }

      // ==================== 创建 ====================
      if (action === 'create') {
        if (!project || !summary) {
          return { success: false, error: '创建 Issue 需要 project 和 summary 参数' };
        }

        context.emit?.('tool_output', {
          tool: 'jira',
          message: `➕ 正在创建 Issue: ${summary}`,
        });

        const createPayload: any = {
          fields: {
            project: { key: project },
            summary,
            issuetype: { name: issue_type },
          },
        };

        if (description) {
          // Jira Cloud 使用 ADF 格式
          createPayload.fields.description = {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: description }],
              },
            ],
          };
        }

        if (priority) {
          createPayload.fields.priority = { name: priority };
        }

        if (labels && labels.length > 0) {
          createPayload.fields.labels = labels;
        }

        const response = await callJiraApi(config, 'POST', '/issue', createPayload);

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`创建失败: ${error}`);
        }

        const created = await response.json();

        logger.info('Jira issue created', { key: created.key });

        return {
          success: true,
          output: `✅ Issue 创建成功！

**Key**: ${created.key}
**链接**: ${config.baseUrl}/browse/${created.key}
**标题**: ${summary}
**类型**: ${issue_type}`,
          metadata: {
            key: created.key,
            id: created.id,
            self: created.self,
            url: `${config.baseUrl}/browse/${created.key}`,
          },
        };
      }

      return {
        success: false,
        error: `未知操作: ${action}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Jira operation failed', { action, error: message });
      return {
        success: false,
        error: `Jira 操作失败: ${message}`,
      };
    }
  },
};
