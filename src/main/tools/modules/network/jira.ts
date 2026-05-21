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
} from '../../../protocol/tools';
import { z } from 'zod';
import { getConfigService } from '../../../services';
import { JIRA_API_VERSION_PATH } from '../../../../shared/constants';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { jiraSchema as schema } from './jira.schema';

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

interface JiraNamedEntity {
  name?: string;
}

interface JiraUser {
  displayName?: string;
}

interface JiraIssueFields {
  summary?: string;
  status?: JiraNamedEntity | null;
  issuetype?: JiraNamedEntity | null;
  priority?: JiraNamedEntity | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  created?: string;
  updated?: string;
  labels?: string[];
  description?: unknown;
}

interface JiraIssue {
  key?: string;
  id?: string;
  self?: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  total: number;
  issues: JiraIssue[];
}

interface JiraCreatedIssue {
  key?: string;
  id?: string;
  self?: string;
}

const NumberishSchema = z.preprocess((value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}, z.number());

const JiraNamedEntitySchema: z.ZodType<JiraNamedEntity | null> = z.object({
  name: z.string().optional(),
}).passthrough().nullable();

const JiraUserSchema: z.ZodType<JiraUser | null> = z.object({
  displayName: z.string().optional(),
}).passthrough().nullable();

const JiraIssueFieldsSchema: z.ZodType<JiraIssueFields, unknown> = z.object({
  summary: z.string().optional(),
  status: JiraNamedEntitySchema.optional(),
  issuetype: JiraNamedEntitySchema.optional(),
  priority: JiraNamedEntitySchema.optional(),
  assignee: JiraUserSchema.optional(),
  reporter: JiraUserSchema.optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  labels: z.array(z.string()).optional().catch([]),
  description: z.unknown().optional(),
}).passthrough();

const JiraIssueSchema: z.ZodType<JiraIssue, unknown> = z.object({
  key: z.string().optional(),
  id: z.string().optional(),
  self: z.string().optional(),
  fields: z.preprocess(
    (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    JiraIssueFieldsSchema,
  ),
}).passthrough();

const JiraSearchResponseSchema: z.ZodType<JiraSearchResponse, unknown> = z.object({
  total: NumberishSchema.catch(0),
  issues: z.array(JiraIssueSchema).optional().default([]),
}).passthrough();

const JiraCreatedIssueSchema: z.ZodType<JiraCreatedIssue, unknown> = z.object({
  key: z.string().optional(),
  id: z.string().optional(),
  self: z.string().optional(),
}).passthrough();

interface JiraDescriptionDocument {
  type: 'doc';
  version: 1;
  content: Array<{
    type: 'paragraph';
    content: Array<{ type: 'text'; text: string }>;
  }>;
}

interface JiraCreatePayload {
  fields: {
    project: { key: string };
    summary: string;
    issuetype: { name: string };
    description?: JiraDescriptionDocument;
    priority?: { name: string };
    labels?: string[];
  };
}

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

  return fetch(`${config.baseUrl}${JIRA_API_VERSION_PATH}${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function parseJiraJson<T>(
  responseBody: unknown,
  schema: z.ZodType<T, unknown>,
  label: string,
): T {
  const parsed = schema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error(`Invalid Jira ${label} response`);
  }
  return parsed.data;
}

function formatIssue(issue: JiraIssue): string {
  const fields = issue.fields;
  return `**${issue.key || 'UNKNOWN'}**: ${fields.summary || '(无标题)'}
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

      const data = parseJiraJson(await response.json() as unknown, JiraSearchResponseSchema, 'search');
      const issues = data.issues || [];

      if (issues.length === 0) {
        onProgress?.({ stage: 'completing', percent: 100 });
        const output = '未找到匹配的 Issue';
        return {
          ok: true,
          output,
          meta: {
            action,
            query: queryJql,
            total: data.total ?? 0,
            returned: 0,
            issues: [],
            artifact: createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'search',
              sessionId: ctx.sessionId,
              name: 'jira-query',
              mimeType: 'text/plain',
              contentLength: output.length,
              preview: output,
              metadata: {
                action,
                query: queryJql,
                total: data.total ?? 0,
                returned: 0,
              },
            }),
          },
        };
      }

      let output = `📋 找到 ${issues.length} 个 Issue (共 ${data.total} 个)\n\n`;
      output += issues.map((issue) => formatIssue(issue)).join('\n\n');

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output,
        meta: {
          action,
          total: data.total,
          returned: issues.length,
          query: queryJql,
          issues: issues.map((issue) => ({ key: issue.key, summary: issue.fields.summary })),
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'search',
            sessionId: ctx.sessionId,
            name: 'jira-query',
            mimeType: 'text/markdown',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              action,
              query: queryJql,
              total: data.total,
              returned: issues.length,
            },
          }),
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

      const issue = parseJiraJson(await response.json() as unknown, JiraIssueSchema, 'issue');
      const fields = issue.fields;
      const labelsForIssue = fields.labels ?? [];

      let output = `📄 ${issue.key}: ${fields.summary}\n\n`;
      output += `**状态**: ${fields.status?.name || '未知'}\n`;
      output += `**类型**: ${fields.issuetype?.name || '未知'}\n`;
      output += `**优先级**: ${fields.priority?.name || '未知'}\n`;
      output += `**指派**: ${fields.assignee?.displayName || '未分配'}\n`;
      output += `**报告人**: ${fields.reporter?.displayName || '未知'}\n`;
      output += `**创建时间**: ${fields.created || '未知'}\n`;
      output += `**更新时间**: ${fields.updated || '未知'}\n`;

      if (labelsForIssue.length > 0) {
        output += `**标签**: ${labelsForIssue.join(', ')}\n`;
      }

      if (fields.description) {
        output += `\n**描述**:\n${typeof fields.description === 'string' ? fields.description : JSON.stringify(fields.description, null, 2)}`;
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output,
        meta: {
          issue,
          issueKey: issue.key,
          action,
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `jira-${issue.key}`,
            url: `${config.baseUrl}/browse/${issue.key}`,
            mimeType: 'text/markdown',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              action,
              issueKey: issue.key,
              summary: fields.summary,
              status: fields.status?.name,
            },
          }),
        },
      };
    }

    // ==================== 创建 ====================
    if (action === 'create') {
      if (!project || !summary) {
        return { ok: false, error: '创建 Issue 需要 project 和 summary 参数', code: 'INVALID_ARGS' };
      }

      onProgress?.({ stage: 'running', detail: `创建: ${summary}` });

      const createPayload: JiraCreatePayload = {
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

      const created = parseJiraJson(await response.json() as unknown, JiraCreatedIssueSchema, 'created issue');
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
