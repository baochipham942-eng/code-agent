// ============================================================================
// Model Router - Routes requests to different AI model providers
// ============================================================================

import type {
  ModelConfig,
  ToolDefinition,
  ToolCall,
  ModelCapability,
  ModelInfo,
  ProviderConfig
} from '../../shared/types';
import axios, { type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// System proxy configuration - only use proxy if explicitly set via env var
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const USE_PROXY = !!PROXY_URL && process.env.NO_PROXY !== 'true' && process.env.DISABLE_PROXY !== 'true';
const httpsAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;

console.log('[ModelRouter] Proxy:', USE_PROXY ? PROXY_URL : 'disabled (no proxy env var set)');

// Helper function to wrap axios in a fetch-like interface for consistency
async function electronFetch(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; body?: ReadableStream<Uint8Array> }> {
  try {
    const response: AxiosResponse = await axios({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.body ? JSON.parse(options.body) : undefined,
      timeout: 300000,
      httpsAgent,
      validateStatus: () => true, // Don't throw on non-2xx status
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      json: async () => response.data,
    };
  } catch (error: any) {
    throw new Error(`Network request failed: ${error.message}`);
  }
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface ModelMessage {
  role: string;
  content: string | MessageContent[];
}

interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface ModelResponse {
  type: 'text' | 'tool_use';
  content?: string;
  toolCalls?: ToolCall[];
}

type StreamCallback = (chunk: string) => void;

// ----------------------------------------------------------------------------
// Provider Registry - 模型能力注册表
// ----------------------------------------------------------------------------

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    requiresApiKey: true,
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        capabilities: ['general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'deepseek-coder',
        name: 'DeepSeek Coder',
        capabilities: ['code'],
        maxTokens: 16384,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek R1',
        capabilities: ['reasoning', 'code'],
        maxTokens: 65536,
        supportsTool: false,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  claude: {
    id: 'claude',
    name: 'Anthropic Claude',
    requiresApiKey: true,
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude 4 Sonnet',
        capabilities: ['general', 'code', 'vision', 'gui'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        capabilities: ['general', 'code', 'vision', 'gui'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        capabilities: ['fast', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    baseUrl: 'https://api.openai.com/v1',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        capabilities: ['general', 'code', 'vision'],
        maxTokens: 4096,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        capabilities: ['fast', 'general'],
        maxTokens: 4096,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
    ],
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    requiresApiKey: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B',
        capabilities: ['fast', 'general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'llama-3.1-8b-instant',
        name: 'Llama 3.1 8B Instant',
        capabilities: ['fast'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'llama-3.2-11b-vision-preview',
        name: 'Llama 3.2 11B Vision',
        capabilities: ['fast', 'vision'],
        maxTokens: 8192,
        supportsTool: false,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'mixtral-8x7b-32768',
        name: 'Mixtral 8x7B',
        capabilities: ['fast', 'code'],
        maxTokens: 32768,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  local: {
    id: 'local',
    name: 'Local (Ollama)',
    requiresApiKey: false,
    baseUrl: 'http://localhost:11434/v1',
    models: [
      {
        id: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        capabilities: ['code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱 GLM',
    requiresApiKey: true,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      {
        id: 'glm-4-flash',
        name: 'GLM-4 Flash',
        capabilities: ['general', 'code', 'fast'],
        maxTokens: 4096,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'glm-4-plus',
        name: 'GLM-4 Plus',
        capabilities: ['general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'glm-4-long',
        name: 'GLM-4 Long',
        capabilities: ['general', 'code'],
        maxTokens: 16384,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'glm-4v-plus',
        name: 'GLM-4V Plus (视觉)',
        capabilities: ['vision', 'gui'],
        maxTokens: 4096,
        supportsTool: false,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'glm-4v-flash',
        name: 'GLM-4V Flash (视觉)',
        capabilities: ['vision', 'fast'],
        maxTokens: 4096,
        supportsTool: false,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'codegeex-4',
        name: 'CodeGeeX-4 (代码专用)',
        capabilities: ['code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  qwen: {
    id: 'qwen',
    name: '通义千问',
    requiresApiKey: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      {
        id: 'qwen-max',
        name: 'Qwen Max',
        capabilities: ['general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'qwen-turbo',
        name: 'Qwen Turbo',
        capabilities: ['fast', 'general'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'qwen-vl-max',
        name: 'Qwen VL Max (视觉)',
        capabilities: ['vision'],
        maxTokens: 4096,
        supportsTool: false,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'qwen-coder-plus',
        name: 'Qwen Coder Plus (代码专用)',
        capabilities: ['code'],
        maxTokens: 16384,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    requiresApiKey: true,
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot V1 8K',
        capabilities: ['general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot V1 32K',
        capabilities: ['general', 'code'],
        maxTokens: 32768,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot V1 128K (超长上下文)',
        capabilities: ['general', 'code'],
        maxTokens: 131072,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    requiresApiKey: true,
    baseUrl: 'https://api.perplexity.ai',
    models: [
      {
        id: 'sonar-pro',
        name: 'Sonar Pro (联网搜索)',
        capabilities: ['search', 'general'],
        maxTokens: 4096,
        supportsTool: false,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'sonar',
        name: 'Sonar (联网搜索)',
        capabilities: ['search', 'fast'],
        maxTokens: 4096,
        supportsTool: false,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
};

// ----------------------------------------------------------------------------
// Model Router
// ----------------------------------------------------------------------------

export class ModelRouter {
  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 根据能力需求选择最佳模型
   */
  selectModelByCapability(
    capability: ModelCapability,
    availableProviders: string[]
  ): { provider: string; model: string } | null {
    for (const providerId of availableProviders) {
      const provider = PROVIDER_REGISTRY[providerId];
      if (!provider) continue;

      const model = provider.models.find((m) =>
        m.capabilities.includes(capability)
      );
      if (model) {
        return { provider: providerId, model: model.id };
      }
    }
    return null;
  }

  /**
   * 获取模型信息
   */
  getModelInfo(provider: string, modelId: string): ModelInfo | null {
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) return null;
    return providerConfig.models.find((m) => m.id === modelId) || null;
  }

  /**
   * 主推理入口
   */
  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    switch (config.provider) {
      case 'deepseek':
        return this.callDeepSeek(messages, tools, config, onStream);
      case 'claude':
        return this.callClaude(messages, tools, config, onStream);
      case 'openai':
        return this.callOpenAI(messages, tools, config, onStream);
      case 'groq':
        return this.callGroq(messages, tools, config, onStream);
      case 'local':
        return this.callLocal(messages, tools, config, onStream);
      case 'zhipu':
        return this.callZhipu(messages, tools, config, onStream);
      case 'qwen':
        return this.callQwen(messages, tools, config, onStream);
      case 'moonshot':
        return this.callMoonshot(messages, tools, config, onStream);
      case 'perplexity':
        return this.callPerplexity(messages, tools, config, onStream);
      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }
  }

  /**
   * 带视觉能力的推理
   */
  async inferenceWithVision(
    messages: ModelMessage[],
    images: Array<{ data: string; mediaType: string }>,
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    // 检查模型是否支持视觉
    const modelInfo = this.getModelInfo(config.provider, config.model);
    if (!modelInfo?.supportsVision) {
      throw new Error(`Model ${config.model} does not support vision`);
    }

    // 构建带图片的消息
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && typeof lastMessage.content === 'string') {
      const content: MessageContent[] = [
        { type: 'text', text: lastMessage.content },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.data,
          },
        })),
      ];
      messages[messages.length - 1] = { ...lastMessage, content };
    }

    return this.inference(messages, [], config, onStream);
  }

  // --------------------------------------------------------------------------
  // Provider Implementations
  // --------------------------------------------------------------------------

  private async callDeepSeek(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';

    // Convert tools to OpenAI format with strict schema
    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.normalizeJsonSchema(tool.inputSchema),
        // Enable strict mode for better JSON compliance
        strict: true,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'deepseek-chat',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: false,
    };

    // Only add tools if we have any
    if (openaiTools.length > 0) {
      requestBody.tools = openaiTools;
      requestBody.tool_choice = 'auto';
    }

    try {
      const response = await axios.post(`${baseUrl}/chat/completions`, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        timeout: 300000,
        httpsAgent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        responseType: 'json',
      });

      console.log('[ModelRouter] DeepSeek raw response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
      return this.parseOpenAIResponse(response.data);
    } catch (error: any) {
      if (error.response) {
        throw new Error(`DeepSeek API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw new Error(`DeepSeek request failed: ${error.message}`);
    }
  }

  /**
   * Normalize JSON Schema for better model compliance
   * - Adds additionalProperties: false to objects
   * - Ensures required fields are properly defined
   * - Recursively processes nested objects and arrays
   */
  private normalizeJsonSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const normalized: any = { ...schema };

    // For object types, add additionalProperties: false if not set
    if (schema.type === 'object') {
      if (normalized.additionalProperties === undefined) {
        normalized.additionalProperties = false;
      }

      // Recursively normalize properties
      if (normalized.properties) {
        const normalizedProps: any = {};
        for (const [key, value] of Object.entries(normalized.properties)) {
          normalizedProps[key] = this.normalizeJsonSchema(value);
        }
        normalized.properties = normalizedProps;
      }
    }

    // For array types, normalize items
    if (schema.type === 'array' && normalized.items) {
      normalized.items = this.normalizeJsonSchema(normalized.items);
    }

    return normalized;
  }

  private async callClaude(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = 'https://api.anthropic.com/v1';

    // Convert messages for Claude format
    const systemMessage = messages.find((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    // Convert tools to Claude format
    const claudeTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // 如果启用 Computer Use，添加计算机工具
    if (config.computerUse) {
      claudeTools.push({
        name: 'computer',
        description: 'Control computer screen, mouse and keyboard',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['screenshot', 'click', 'type', 'scroll', 'key', 'move'],
              description: 'The action to perform',
            },
            coordinate: {
              type: 'array',
              description: '[x, y] coordinate for click/move actions',
            },
            text: {
              type: 'string',
              description: 'Text to type',
            },
          },
          required: ['action'],
        },
      } as any);
    }

    const requestBody: Record<string, unknown> = {
      model: config.model || 'claude-sonnet-4-20250514',
      max_tokens: config.maxTokens ?? 4096,
      messages: this.convertToClaudeMessages(otherMessages),
    };

    if (systemMessage) {
      requestBody.system =
        typeof systemMessage.content === 'string'
          ? systemMessage.content
          : systemMessage.content[0]?.text || '';
    }

    if (claudeTools.length > 0) {
      requestBody.tools = claudeTools;
    }

    // Computer Use beta header
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01',
    };

    if (config.computerUse) {
      headers['anthropic-beta'] = 'computer-use-2024-10-22';
    }

    const response = await electronFetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return this.parseClaudeResponse(data);
  }

  private async callOpenAI(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://api.openai.com/v1';

    // Convert tools to OpenAI format
    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'gpt-4o',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
    };

    if (openaiTools.length > 0) {
      requestBody.tools = openaiTools;
    }

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }

  private async callGroq(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://api.groq.com/openai/v1';

    // Groq 使用 OpenAI 兼容格式
    const groqTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'llama-3.3-70b-versatile',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: !!onStream,
    };

    // Groq 部分模型不支持 tools
    const modelInfo = this.getModelInfo('groq', config.model);
    if (groqTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = groqTools;
      requestBody.tool_choice = 'auto';
    }

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }

  private async callLocal(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    // Ollama 使用 OpenAI 兼容 API
    const baseUrl = config.baseUrl || 'http://localhost:11434/v1';

    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'qwen2.5-coder:7b',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      stream: !!onStream,
    };

    if (openaiTools.length > 0) {
      requestBody.tools = openaiTools;
    }

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Local model error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }

  // --------------------------------------------------------------------------
  // Message Conversion
  // --------------------------------------------------------------------------

  private convertToOpenAIMessages(messages: ModelMessage[]): any[] {
    return messages.map((m) => {
      if (typeof m.content === 'string') {
        return {
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        };
      }

      // 处理多模态消息
      return {
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content.map((c) => {
          if (c.type === 'text') {
            return { type: 'text', text: c.text };
          }
          if (c.type === 'image' && c.source) {
            return {
              type: 'image_url',
              image_url: {
                url: `data:${c.source.media_type};base64,${c.source.data}`,
              },
            };
          }
          return c;
        }),
      };
    });
  }

  private convertToClaudeMessages(messages: ModelMessage[]): any[] {
    return messages.map((m) => {
      if (typeof m.content === 'string') {
        return {
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        };
      }

      // Claude 原生支持多模态格式
      return {
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Response Parsing
  // --------------------------------------------------------------------------

  private parseOpenAIResponse(data: any): ModelResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No response from model');
    }

    const message = choice.message;

    // Check for standard tool calls format
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = [];

      for (const tc of message.tool_calls) {
        try {
          const args = this.safeParseJson(tc.function.arguments || '{}', tc.function.name);
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          });
        } catch (parseError: any) {
          console.error(`[ModelRouter] Failed to parse tool call arguments for ${tc.function.name}:`, parseError.message);
          // Try to repair common JSON issues
          const repairedArgs = this.repairJson(tc.function.arguments || '{}');
          if (repairedArgs) {
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: repairedArgs,
            });
          } else {
            // Log and skip this tool call, return as text instead
            console.error('[ModelRouter] Could not repair JSON, raw arguments:', tc.function.arguments?.substring(0, 500));
            const content = message.content || `Tool call failed: ${tc.function.name} - Invalid JSON arguments`;
            return { type: 'text', content };
          }
        }
      }

      if (toolCalls.length > 0) {
        return { type: 'tool_use', toolCalls };
      }
    }

    const content = message.content || '';

    // Fallback: parse text-based tool calls (e.g., "Calling tool_name({...})")
    // This handles models that don't properly use tool_calls format
    // Match anywhere in the content, not just at the beginning
    const textToolCallMatch = content.match(/Calling\s+(\w+)\s*\(/);
    if (textToolCallMatch) {
      const toolName = textToolCallMatch[1];
      // Find the position of "Calling tool_name(" and extract JSON
      const callStart = content.indexOf(textToolCallMatch[0]);
      const argsStart = callStart + textToolCallMatch[0].length;

      // Find matching closing parenthesis by counting brackets
      let depth = 1;
      let argsEnd = argsStart;
      for (let i = argsStart; i < content.length && depth > 0; i++) {
        if (content[i] === '{' || content[i] === '[') depth++;
        else if (content[i] === '}' || content[i] === ']') depth--;
        else if (content[i] === ')' && depth === 1) {
          argsEnd = i;
          break;
        }
        argsEnd = i + 1;
      }

      const argsStr = content.slice(argsStart, argsEnd);
      try {
        const args = this.safeParseJson(argsStr, toolName);
        console.log('[ModelRouter] Parsed text-based tool call:', toolName);
        return {
          type: 'tool_use',
          toolCalls: [{
            id: `text-${Date.now()}`,
            name: toolName,
            arguments: args,
          }],
        };
      } catch (e) {
        console.error('[ModelRouter] Failed to parse text-based tool call args:', argsStr.substring(0, 100), e);
        // If parsing fails, return as text
      }
    }

    // Text response
    return { type: 'text', content };
  }

  /**
   * Safely parse JSON with better error messages
   */
  private safeParseJson(jsonStr: string, context: string): any {
    try {
      return JSON.parse(jsonStr);
    } catch (error: any) {
      // Provide more context in error message
      const position = error.message.match(/position (\d+)/)?.[1];
      const preview = position
        ? `...${jsonStr.substring(Math.max(0, parseInt(position) - 20), parseInt(position) + 20)}...`
        : jsonStr.substring(0, 100);
      throw new Error(`JSON parse error in ${context}: ${error.message}. Near: ${preview}`);
    }
  }

  /**
   * Attempt to repair common JSON issues
   */
  private repairJson(jsonStr: string): any | null {
    try {
      // Try direct parse first
      return JSON.parse(jsonStr);
    } catch {
      // Try common repairs
      let repaired = jsonStr;

      // 1. Fix truncated strings - find last complete object/array
      const lastBrace = repaired.lastIndexOf('}');
      const lastBracket = repaired.lastIndexOf(']');

      if (lastBrace === -1 && lastBracket === -1) {
        return null;
      }

      // Count braces to check if balanced
      let braceCount = 0;
      let bracketCount = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') braceCount--;
          else if (char === '[') bracketCount++;
          else if (char === ']') bracketCount--;
        }
      }

      // Try to close unclosed structures
      if (inString) {
        repaired += '"';
      }

      while (bracketCount > 0) {
        repaired += ']';
        bracketCount--;
      }

      while (braceCount > 0) {
        repaired += '}';
        braceCount--;
      }

      try {
        const result = JSON.parse(repaired);
        console.log('[ModelRouter] Successfully repaired JSON');
        return result;
      } catch {
        // 2. Try to extract just the first complete object
        try {
          const match = jsonStr.match(/^\s*\{[\s\S]*?\}(?=\s*$|\s*,|\s*\])/);
          if (match) {
            return JSON.parse(match[0]);
          }
        } catch {
          // Ignore
        }

        return null;
      }
    }
  }

  private parseClaudeResponse(data: any): ModelResponse {
    const content = data.content;
    if (!content || content.length === 0) {
      throw new Error('No response from model');
    }

    // Check for tool use
    const toolUseBlocks = content.filter((block: any) => block.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      const toolCalls: ToolCall[] = toolUseBlocks.map((block: any) => ({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      }));

      return { type: 'tool_use', toolCalls };
    }

    // Text response
    const textBlocks = content.filter((block: any) => block.type === 'text');
    const text = textBlocks.map((block: any) => block.text).join('\n');

    return { type: 'text', content: text };
  }

  private async handleStream(
    body: ReadableStream<Uint8Array>,
    onStream: StreamCallback
  ): Promise<ModelResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let toolCalls: ToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter((line) => line.trim().startsWith('data:'));

        for (const line of lines) {
          const data = line.replace('data:', '').trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              fullContent += delta.content;
              onStream(delta.content);
            }

            // Handle streaming tool calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.index !== undefined) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = {
                      id: tc.id || '',
                      name: tc.function?.name || '',
                      arguments: {},
                    };
                  }
                  if (tc.function?.arguments) {
                    const existing = toolCalls[tc.index];
                    const args = existing.arguments as Record<string, string>;
                    args._raw = (args._raw || '') + tc.function.arguments;
                  }
                }
              }
            }
          } catch {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Parse accumulated tool call arguments
    toolCalls = toolCalls.filter(Boolean).map((tc) => {
      const args = tc.arguments as Record<string, string>;
      if (args._raw) {
        try {
          tc.arguments = JSON.parse(args._raw);
        } catch {
          tc.arguments = {};
        }
      }
      return tc;
    });

    if (toolCalls.length > 0) {
      return { type: 'tool_use', toolCalls };
    }

    return { type: 'text', content: fullContent };
  }

  // --------------------------------------------------------------------------
  // 智谱 GLM 调用
  // --------------------------------------------------------------------------

  private async callZhipu(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';

    // 智谱使用 OpenAI 兼容格式
    const zhipuTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'glm-4-flash',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: !!onStream,
    };

    // 检查模型是否支持工具调用
    const modelInfo = this.getModelInfo('zhipu', config.model);
    if (zhipuTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = zhipuTools;
      requestBody.tool_choice = 'auto';
    }

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`智谱 API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }

  // --------------------------------------------------------------------------
  // 千问 Qwen 调用
  // --------------------------------------------------------------------------

  private async callQwen(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

    // 千问使用 OpenAI 兼容格式
    const qwenTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'qwen-max',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: !!onStream,
    };

    const modelInfo = this.getModelInfo('qwen', config.model);
    if (qwenTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = qwenTools;
      requestBody.tool_choice = 'auto';
    }

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`千问 API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }

  // --------------------------------------------------------------------------
  // Moonshot (Kimi) 调用
  // --------------------------------------------------------------------------

  private async callMoonshot(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://api.moonshot.cn/v1';

    // Moonshot 使用 OpenAI 兼容格式
    const moonshotTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'moonshot-v1-8k',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: !!onStream,
    };

    if (moonshotTools.length > 0) {
      requestBody.tools = moonshotTools;
      requestBody.tool_choice = 'auto';
    }

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Moonshot API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }

  // --------------------------------------------------------------------------
  // Perplexity 调用 (联网搜索)
  // --------------------------------------------------------------------------

  private async callPerplexity(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://api.perplexity.ai';

    // Perplexity 使用类 OpenAI 格式，但不支持工具调用
    const requestBody: Record<string, unknown> = {
      model: config.model || 'sonar-pro',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: !!onStream,
    };

    const response = await electronFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Perplexity API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseOpenAIResponse(data);
  }
}
