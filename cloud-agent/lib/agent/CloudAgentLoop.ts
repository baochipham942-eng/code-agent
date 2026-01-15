// ============================================================================
// Cloud Agent Loop - 云端 Agent 循环
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';

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
  {
    name: 'web_search',
    description: '搜索网络获取最新信息。适用于查找文档、教程、最佳实践等。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询词',
        },
        maxResults: {
          type: 'number',
          description: '返回结果数量，默认 5',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '获取指定 URL 的网页内容。',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要获取的 URL',
        },
        selector: {
          type: 'string',
          description: '可选的 CSS 选择器，只提取特定内容',
        },
      },
      required: ['url'],
    },
  },
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
      case 'web_search':
        return this.toolWebSearch(input.query as string, input.maxResults as number);

      case 'web_fetch':
        return this.toolWebFetch(input.url as string, input.selector as string);

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

  private async toolWebSearch(query: string, maxResults = 5): Promise<string> {
    // TODO: 接入实际的搜索 API (如 Perplexity, SerpAPI, Bing)
    // 目前返回模拟结果
    return JSON.stringify({
      query,
      results: [
        {
          title: `Search results for: ${query}`,
          url: 'https://example.com',
          snippet: 'This is a placeholder. Integrate with a real search API.',
        },
      ],
      note: 'Web search API not yet configured',
    });
  }

  // 检查是否为内部/私有 IP 地址
  private isInternalUrl(hostname: string): boolean {
    // 阻止的主机名
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blockedHosts.includes(hostname)) return true;

    // 检查私有 IP 范围
    const privateIpPatterns = [
      /^10\./,                          // 10.0.0.0/8
      /^172\.(1[6-9]|2\d|3[01])\./,     // 172.16.0.0/12
      /^192\.168\./,                     // 192.168.0.0/16
      /^127\./,                          // 127.0.0.0/8
      /^169\.254\./,                     // 169.254.0.0/16 (link-local)
      /^fc00:/i,                         // IPv6 unique local
      /^fe80:/i,                         // IPv6 link-local
    ];

    return privateIpPatterns.some(pattern => pattern.test(hostname));
  }

  private async toolWebFetch(url: string, selector?: string): Promise<string> {
    try {
      // URL 验证和 SSRF 防护
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return JSON.stringify({ error: 'Invalid URL format' });
      }

      // 只允许 HTTP/HTTPS
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return JSON.stringify({ error: 'Only HTTP(S) URLs are allowed' });
      }

      // 阻止内部网络访问
      if (this.isInternalUrl(parsedUrl.hostname)) {
        return JSON.stringify({ error: 'Access to internal URLs is not allowed' });
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'CodeAgent/1.0 (Cloud Agent)',
        },
        redirect: 'follow',
      });

      const html = await response.text();

      // 简单提取文本内容（生产环境应使用 cheerio 或类似库）
      const textContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 5000);

      return JSON.stringify({
        url,
        content: textContent,
        truncated: html.length > 5000,
      });
    } catch (error: any) {
      return JSON.stringify({ error: 'Failed to fetch URL' });
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
