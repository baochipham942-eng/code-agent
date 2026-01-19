// ============================================================================
// Cloud Agent Loop - 云端 Agent 循环
// 支持多模型（DeepSeek 为主，可配置 OpenAI/Anthropic）
// ============================================================================

import {
  ModelClient,
  createModelClient,
  type ModelProvider,
  type ChatMessage,
  type ToolDefinition,
  type ToolCall,
  type StreamEvent,
} from './ModelClient.js';
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
  // 云端工具（使用独立 API 端点）
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
  // LLM 驱动的工具
  {
    name: 'generate_plan',
    description: '为复杂任务生成执行计划。返回客户端可执行的步骤列表。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务描述' },
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
        code: { type: 'string', description: '要审查的代码' },
        language: { type: 'string', description: '编程语言' },
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
        code: { type: 'string', description: '要解释的代码' },
        language: { type: 'string', description: '编程语言' },
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

export interface CloudAgentConfig {
  provider: ModelProvider;
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export class CloudAgentLoop {
  private client: ModelClient;
  private config: CloudAgentConfig;

  constructor(config: CloudAgentConfig) {
    this.config = config;
    this.client = createModelClient(config.provider, config.apiKey, config.model);
  }

  /**
   * 非流式执行
   */
  async run(request: AgentRequest): Promise<string> {
    const messages: ChatMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const tools = (request.tools || CLOUD_TOOLS) as ToolDefinition[];
    const systemPrompt = this.buildSystemPrompt(request);
    const maxIterations = 10;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const response = await this.client.chat(messages, {
        systemPrompt,
        tools,
        maxTokens: request.maxTokens || this.config.maxTokens,
        temperature: this.config.temperature,
      });

      // 如果没有工具调用，返回内容
      if (response.stopReason !== 'tool_use' || !response.toolCalls?.length) {
        return response.content;
      }

      // 处理工具调用
      messages.push({ role: 'assistant', content: response.content });

      for (const toolCall of response.toolCalls) {
        const result = await this.executeCloudTool(toolCall.name, toolCall.input);
        messages.push({
          role: 'user',
          content: `Tool result for ${toolCall.name} (id: ${toolCall.id}):\n${result}`,
        });
      }
    }

    return '达到最大迭代次数，任务未完成。';
  }

  /**
   * 流式执行
   */
  async *stream(request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const messages: ChatMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const tools = (request.tools || CLOUD_TOOLS) as ToolDefinition[];
    const systemPrompt = this.buildSystemPrompt(request);

    try {
      for await (const event of this.client.stream(messages, {
        systemPrompt,
        tools,
        maxTokens: request.maxTokens || this.config.maxTokens,
        temperature: this.config.temperature,
      })) {
        if (event.type === 'text') {
          yield { type: 'text', content: event.content };
        } else if (event.type === 'tool_use' && event.toolCall) {
          yield { type: 'tool_use', toolCall: event.toolCall };

          // 执行工具并返回结果
          const result = await this.executeCloudTool(event.toolCall.name, event.toolCall.input);
          yield {
            type: 'tool_result',
            toolResult: {
              toolUseId: event.toolCall.id,
              content: result,
            },
          };
        } else if (event.type === 'done') {
          yield { type: 'done' };
        } else if (event.type === 'error') {
          yield { type: 'error', error: event.error };
        }
      }
    } catch (error: unknown) {
      yield { type: 'error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
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

  /**
   * 执行云端工具
   */
  private async executeCloudTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      // 云端工具 - 调用独立 API 端点
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

      // 兼容旧工具名
      case 'web_search':
        return this.callCloudToolApi('cloud-search', {
          query: input.query,
          maxResults: input.maxResults,
        });

      case 'web_fetch':
        return this.callCloudToolApi('cloud-scrape', {
          url: input.url,
          selector: input.selector,
        });

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

  /**
   * 调用云端工具 API
   */
  private async callCloudToolApi(
    endpoint: string,
    input: Record<string, unknown>
  ): Promise<string> {
    try {
      const baseUrl = process.env.CLOUD_API_URL || 'https://code-agent-beta.vercel.app';
      const url = `${baseUrl}/api/tools/${endpoint}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to call cloud tool API',
      });
    }
  }

  private async toolGeneratePlan(task: string, constraints?: string[]): Promise<string> {
    const planPrompt = `为以下任务生成一个详细的执行计划，每个步骤应该是客户端可以执行的操作。

任务：${task}
${constraints?.length ? `约束：\n${constraints.map((c) => `- ${c}`).join('\n')}` : ''}

以 JSON 格式返回计划，包含 steps 数组，每个 step 有 action, tool, params, description 字段。`;

    const response = await this.client.chat(
      [{ role: 'user', content: planPrompt }],
      { maxTokens: 2048 }
    );

    return response.content;
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

    const response = await this.client.chat(
      [{ role: 'user', content: reviewPrompt }],
      { maxTokens: 2048 }
    );

    return response.content;
  }

  private async toolExplainCode(
    code: string,
    language?: string,
    level = 'intermediate'
  ): Promise<string> {
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

    const response = await this.client.chat(
      [{ role: 'user', content: explainPrompt }],
      { maxTokens: 2048 }
    );

    return response.content;
  }
}

// 导出类型
export { ToolCall };
