// ============================================================================
// Cloud Agent Loop - 云端 Agent 循环
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { CLOUD_TOOL_SCHEMAS } from '../tools/CloudToolRegistry.js';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentRequest {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: AgentTool[];
  model?: string;
  maxTokens?: number;
  projectContext?: {
    summary?: string;
    fileTree?: string[];
    currentFile?: string;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentStreamEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  toolResult?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  };
  error?: string;
}

// 云端可用的工具定义
export const CLOUD_TOOLS: AgentTool[] = [
  // 新的云端工具（使用独立 API 端点）
  {
    name: 'cloud_search',
    description: CLOUD_TOOL_SCHEMAS.cloud_search.description,
    input_schema: CLOUD_TOOL_SCHEMAS.cloud_search.inputSchema,
  },
  {
    name: 'cloud_scrape',
    description: CLOUD_TOOL_SCHEMAS.cloud_scrape.description,
    input_schema: CLOUD_TOOL_SCHEMAS.cloud_scrape.inputSchema,
  },
  {
    name: 'cloud_api',
    description: CLOUD_TOOL_SCHEMAS.cloud_api.description,
    input_schema: CLOUD_TOOL_SCHEMAS.cloud_api.inputSchema,
  },
  {
    name: 'cloud_memory_store',
    description: CLOUD_TOOL_SCHEMAS.cloud_memory_store.description,
    input_schema: CLOUD_TOOL_SCHEMAS.cloud_memory_store.inputSchema,
  },
  {
    name: 'cloud_memory_search',
    description: CLOUD_TOOL_SCHEMAS.cloud_memory_search.description,
    input_schema: CLOUD_TOOL_SCHEMAS.cloud_memory_search.inputSchema,
  },
  // 保留原有工具（LLM 驱动的）
  {
    name: 'generate_plan',
    description: '为复杂任务生成执行计划。返回客户端可执行的步骤列表。',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '任务描述',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: '约束条件',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'code_review',
    description: '对代码进行审查，发现潜在问题和改进建议。',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要审查的代码',
        },
        language: {
          type: 'string',
          description: '编程语言',
        },
        focus: {
          type: 'array',
          items: { type: 'string' },
          description: '关注点：security, performance, style, bugs',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'explain_code',
    description: '详细解释代码的功能和实现原理。',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要解释的代码',
        },
        language: {
          type: 'string',
          description: '编程语言',
        },
        level: {
          type: 'string',
          enum: ['beginner', 'intermediate', 'advanced'],
          description: '解释的详细程度',
        },
      },
      required: ['code'],
    },
  },
];

export class CloudAgentLoop {
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY is required. Set it in environment variables or pass it to the constructor.');
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model || 'claude-sonnet-4-20250514';
  }

  // 非流式执行（简单场景）
  async run(request: AgentRequest): Promise<string> {
    const messages = this.buildMessages(request);
    const tools = request.tools || CLOUD_TOOLS;

    let response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens || 4096,
      system: this.buildSystemPrompt(request),
      messages,
      tools: tools as Anthropic.Tool[],
    });

    // Agent Loop: 持续处理工具调用
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (toolUse) => ({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: await this.executeCloudTool(toolUse.name, toolUse.input as Record<string, unknown>),
        }))
      );

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens || 4096,
        system: this.buildSystemPrompt(request),
        messages,
        tools: tools as Anthropic.Tool[],
      });
    }

    // 提取最终文本响应
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );

    return textBlocks.map((b) => b.text).join('\n');
  }

  // 流式执行（实时响应）
  async *stream(request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const messages = this.buildMessages(request);
    const tools = request.tools || CLOUD_TOOLS;

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: request.maxTokens || 4096,
        system: this.buildSystemPrompt(request),
        messages,
        tools: tools as Anthropic.Tool[],
      });

      let currentToolCall: Partial<ToolCall> | null = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolCall = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text };
          } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
            // 累积工具输入 JSON
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolCall?.id && currentToolCall?.name) {
            yield { type: 'tool_use', toolCall: currentToolCall as ToolCall };

            // 执行工具并返回结果
            const result = await this.executeCloudTool(
              currentToolCall.name,
              currentToolCall.input || {}
            );

            yield {
              type: 'tool_result',
              toolResult: {
                toolUseId: currentToolCall.id,
                content: result,
              },
            };

            currentToolCall = null;
          }
        }
      }

      yield { type: 'done' };
    } catch (error: any) {
      yield { type: 'error', error: error.message };
    }
  }

  private buildMessages(request: AgentRequest): Anthropic.MessageParam[] {
    return request.messages.map((msg) => ({
      role: msg.role === 'system' ? 'user' : msg.role,
      content: msg.content,
    }));
  }

  private buildSystemPrompt(request: AgentRequest): string {
    let prompt =
      request.systemPrompt ||
      `你是 Code Agent 的云端助手，专注于复杂推理、代码分析和需要联网能力的任务。

你可以：
- 搜索网络获取最新信息
- 分析和解释复杂代码
- 生成执行计划供客户端本地执行
- 进行代码审查

你应该：
- 对于需要文件操作的任务，生成计划让客户端执行
- 对于简单问题，直接回答
- 对于复杂任务，分步骤说明`;

    if (request.projectContext) {
      prompt += '\n\n## 项目上下文\n';
      if (request.projectContext.summary) {
        prompt += `\n项目概要：${request.projectContext.summary}`;
      }
      if (request.projectContext.fileTree?.length) {
        prompt += `\n\n文件结构：\n${request.projectContext.fileTree.slice(0, 50).join('\n')}`;
      }
      if (request.projectContext.currentFile) {
        prompt += `\n\n当前文件：${request.projectContext.currentFile}`;
      }
    }

    return prompt;
  }

  // 执行云端工具
  private async executeCloudTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      // 新的云端工具 - 调用独立 API 端点
      case 'cloud_search':
        return this.callCloudToolApi('cloud-search', input);

      case 'cloud_scrape':
        return this.callCloudToolApi('cloud-scrape', input);

      case 'cloud_api':
        return this.callCloudToolApi('cloud-api', input);

      case 'cloud_memory_store':
        return this.callCloudToolApi('cloud-memory', { action: 'store', ...input });

      case 'cloud_memory_search':
        return this.callCloudToolApi('cloud-memory', { action: 'search', ...input });

      // 保留的旧工具名（向后兼容）
      case 'web_search':
        return this.callCloudToolApi('cloud-search', { query: input.query, maxResults: input.maxResults });

      case 'web_fetch':
        return this.callCloudToolApi('cloud-scrape', { url: input.url, selector: input.selector });

      // LLM 驱动的工具
      case 'generate_plan':
        return this.toolGeneratePlan(input.task as string, input.constraints as string[]);

      case 'code_review':
        return this.toolCodeReview(
          input.code as string,
          input.language as string,
          input.focus as string[]
        );

      case 'explain_code':
        return this.toolExplainCode(
          input.code as string,
          input.language as string,
          input.level as string
        );

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  // 调用云端工具 API
  private async callCloudToolApi(
    endpoint: string,
    input: Record<string, unknown>
  ): Promise<string> {
    try {
      // 确定 API 基础 URL
      const baseUrl = process.env.CLOUD_API_URL || 'https://code-agent-beta.vercel.app';
      const url = `${baseUrl}/api/tools/${endpoint}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      const result = await response.json();

      if (!response.ok) {
        return JSON.stringify({
          error: result.error || `API request failed with status ${response.status}`,
        });
      }

      return JSON.stringify(result);
    } catch (error) {
      const err = error as Error;
      return JSON.stringify({
        error: err.message || 'Failed to call cloud tool API',
      });
    }
  }

  private async toolGeneratePlan(task: string, constraints?: string[]): Promise<string> {
    // 使用 LLM 生成计划
    const planPrompt = `为以下任务生成一个详细的执行计划，每个步骤应该是客户端可以执行的操作。

任务：${task}
${constraints?.length ? `约束：\n${constraints.map((c) => `- ${c}`).join('\n')}` : ''}

以 JSON 格式返回计划，包含 steps 数组，每个 step 有 action, tool, params, description 字段。`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: planPrompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return text;
  }

  private async toolCodeReview(
    code: string,
    language?: string,
    focus?: string[]
  ): Promise<string> {
    const reviewPrompt = `请审查以下${language || ''}代码：

\`\`\`${language || ''}
${code}
\`\`\`

${focus?.length ? `重点关注：${focus.join(', ')}` : ''}

请指出：
1. 潜在的 Bug 或问题
2. 安全隐患
3. 性能优化建议
4. 代码风格改进`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: reviewPrompt }],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  private async toolExplainCode(code: string, language?: string, level = 'intermediate'): Promise<string> {
    const levelDescriptions = {
      beginner: '用简单的语言解释，假设读者刚学编程',
      intermediate: '用专业但清晰的语言解释',
      advanced: '深入技术细节，包括底层原理',
    };

    const explainPrompt = `请解释以下${language || ''}代码：

\`\`\`${language || ''}
${code}
\`\`\`

${levelDescriptions[level as keyof typeof levelDescriptions] || levelDescriptions.intermediate}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: explainPrompt }],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}
