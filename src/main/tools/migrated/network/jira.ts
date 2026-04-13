// ============================================================================
// jira (P0-6.3 Batch 9 — network: native ToolModule rewrite)
//
// Jira 问题管理：查询、获取、创建 Issue（REST v3）。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getConfigService } from '../../../services';

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

const schema: ToolSchema = {
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

function getJiraConfig(): JiraConfig | null {
  const envBaseUrl = process.env.JIRA_BASE_URL;
  const envEmail = process.env.JIRA_EMAIL;
  const envApiToken = process.env.JIRA_API_TOKEN;

  if (envBaseUrl && envEmail && envApiToken) {
    return { baseUrl: envBaseUrl, email: envEmail, apiToken: envApiToken };
  }

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

async function callJiraApi(
  config: JiraConfig,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<Response> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

  return fetch(`${config.baseUrl}/rest/api/3${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatIssue(issue: any): string {
  const fields = issue.fields || {};
  return `**${issue.key}**: ${fields.summary || '(无标题)'}
  状态: ${fields.status?.name || '未知'}
  类型: ${fields.issuetype?.name || '未知'}
  优先级: ${fields.priority?.name || '未知'}
  指派: ${fields.assignee?.displayName || '未分配'}
  创建: ${fields.created ? new Date(fields.created).toLocaleDateString() : '未知'}`;
}

export async function executeJira(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action as 'query' | 'create' | 'get' | undefined;
  if (!action || !['query', 'create', 'get'].includes(action)) {
    return { ok: false, error: 'action is required and must be one of query|create|get', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `jira:${action}` });

  const config = getJiraConfig();
  if (!config) {
    return {
      ok: false,
      error: `Jira 未配置。请设置以下环境变量：
- JIRA_BASE_URL: Jira 实例 URL
- JIRA_EMAIL: 登录邮箱
- JIRA_API_TOKEN: API Token

或在设置中配置 jira.baseUrl, jira.email, jira.apiToken`,
      code: 'AUTH_REQUIRED',
    };
  }

  const jql = args.jql as string | undefined;
  const project = args.project as string | undefined;
  const status = args.status as string | undefined;
  const assignee = args.assignee as string | undefined;
  const maxResults = (args.max_results as number | undefined) ?? 20;
  const issueKey = args.issue_key as string | undefined;
  const summary = args.summary as string | undefined;
  const description = args.description as string | undefined;
  const issueType = (args.issue_type as string | undefined) ?? 'Task';
  const priority = args.priority as string | undefined;
  const labels = args.labels as string[] | undefined;

  try {
    // ==================== 查询 ====================
    if (action === 'query') {
      let queryJql = jql;
      if (!queryJql) {
        const conditions: string[] = [];
        if (project) conditions.push(`project = "${project}"`);
        if (status) conditions.push(`status = "${status}"`);
        if (assignee) conditions.push(`assignee = "${assignee}"`);
        queryJql = conditions.length > 0 ? conditions.join(' AND ') : 'ORDER BY created DESC';
      }

      onProgress?.({ stage: 'running', detail: `查询: ${queryJql}` });

      const response = await callJiraApi(
        config,
        'GET',
        `/search?jql=${encodeURIComponent(queryJql)}&maxResults=${maxResults}`,
      );

      if (!response.ok) {
        const err = await response.text();
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: `Jira 认证失败 (${response.status}): ${err}`, code: 'AUTH_REQUIRED' };
        }
        return { ok: false, error: `查询失败 (${response.status}): ${err}`, code: 'NETWORK_ERROR' };
      }

      const data = await response.json();
      const issues = data.issues || [];

      if (issues.length === 0) {
        onProgress?.({ stage: 'completing', percent: 100 });
        return { ok: true, output: '未找到匹配的 Issue' };
      }

      let output = `📋 找到 ${issues.length} 个 Issue (共 ${data.total} 个)\n\n`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      output += issues.map((issue: any) => formatIssue(issue)).join('\n\n');

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output,
        meta: {
          total: data.total,
          returned: issues.length,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          issues: issues.map((i: any) => ({ key: i.key, summary: i.fields?.summary })),
        },
      };
    }

    // ==================== 获取单个 ====================
    if (action === 'get') {
      if (!issueKey) {
        return { ok: false, error: '缺少 issue_key 参数', code: 'INVALID_ARGS' };
      }

      onProgress?.({ stage: 'running', detail: `获取: ${issueKey}` });

      const response = await callJiraApi(config, 'GET', `/issue/${issueKey}`);

      if (!response.ok) {
        const err = await response.text();
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: `Jira 认证失败 (${response.status}): ${err}`, code: 'AUTH_REQUIRED' };
        }
        return { ok: false, error: `获取失败 (${response.status}): ${err}`, code: 'NETWORK_ERROR' };
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

      onProgress?.({ stage: 'completing', percent: 100 });
      return { ok: true, output, meta: { issue } };
    }

    // ==================== 创建 ====================
    if (action === 'create') {
      if (!project || !summary) {
        return { ok: false, error: '创建 Issue 需要 project 和 summary 参数', code: 'INVALID_ARGS' };
      }

      onProgress?.({ stage: 'running', detail: `创建: ${summary}` });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createPayload: any = {
        fields: {
          project: { key: project },
          summary,
          issuetype: { name: issueType },
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
        const err = await response.text();
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: `Jira 认证失败 (${response.status}): ${err}`, code: 'AUTH_REQUIRED' };
        }
        return { ok: false, error: `创建失败 (${response.status}): ${err}`, code: 'NETWORK_ERROR' };
      }

      const created = await response.json();
      ctx.logger.info('Jira issue created', { key: created.key });

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `✅ Issue 创建成功！

**Key**: ${created.key}
**链接**: ${config.baseUrl}/browse/${created.key}
**标题**: ${summary}
**类型**: ${issueType}`,
        meta: {
          key: created.key,
          id: created.id,
          self: created.self,
          url: `${config.baseUrl}/browse/${created.key}`,
        },
      };
    }

    return { ok: false, error: `未知操作: ${action}`, code: 'INVALID_ARGS' };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('Jira operation failed', { action, error: message });
    return { ok: false, error: `Jira 操作失败: ${message}`, code: 'NETWORK_ERROR' };
  }
}

class JiraHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeJira(args, ctx, canUseTool, onProgress);
  }
}

export const jiraModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new JiraHandler();
  },
};
