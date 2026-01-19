// ============================================================================
// Model Router - Routes requests to different AI model providers
// ============================================================================

import type {
  ModelConfig,
  ToolDefinition,
  ToolCall,
  ModelCapability,
  ModelInfo,
  ProviderConfig,
  ModelProvider
} from '../../shared/types';
import axios, { type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'https';
import http from 'http';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ModelRouter');

// System proxy configuration - only use proxy if explicitly set via env var
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const USE_PROXY = !!PROXY_URL && process.env.NO_PROXY !== 'true' && process.env.DISABLE_PROXY !== 'true';
const httpsAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;

logger.info(' Proxy:', USE_PROXY ? PROXY_URL : 'disabled (no proxy env var set)');

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
  truncated?: boolean; // 标记输出是否因 max_tokens 限制被截断
  finishReason?: string; // 原始的 finish_reason
}

// 流式回调类型
interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta';
  content?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
}

type StreamCallback = (chunk: string | StreamChunk) => void;

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
        maxTokens: 16384,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'deepseek-coder',
        name: 'DeepSeek Coder',
        capabilities: ['code'],
        maxTokens: 32768,
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
        maxTokens: 16384,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        capabilities: ['fast', 'general'],
        maxTokens: 16384,
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
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter (中转)',
    requiresApiKey: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      // Google Gemini 系列
      {
        id: 'google/gemini-2.0-flash-001',
        name: 'Gemini 2.0 Flash',
        capabilities: ['general', 'code', 'vision', 'fast'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'google/gemini-2.0-flash-thinking-exp:free',
        name: 'Gemini 2.0 Flash Thinking (免费)',
        capabilities: ['reasoning', 'code'],
        maxTokens: 65536,
        supportsTool: false,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'google/gemini-exp-1206:free',
        name: 'Gemini Exp 1206 (免费)',
        capabilities: ['general', 'code', 'vision'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      // Claude 系列（通过 OpenRouter 中转）
      {
        id: 'anthropic/claude-3.5-sonnet',
        name: 'Claude 3.5 Sonnet (中转)',
        capabilities: ['general', 'code', 'vision'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'anthropic/claude-3.5-haiku',
        name: 'Claude 3.5 Haiku (中转)',
        capabilities: ['fast', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      // OpenAI 系列（通过 OpenRouter 中转）
      {
        id: 'openai/gpt-4o',
        name: 'GPT-4o (中转)',
        capabilities: ['general', 'code', 'vision'],
        maxTokens: 4096,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini (中转)',
        capabilities: ['fast', 'general'],
        maxTokens: 4096,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      // DeepSeek（通过 OpenRouter 中转）
      {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek Chat (中转)',
        capabilities: ['general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek R1 (中转)',
        capabilities: ['reasoning', 'code'],
        maxTokens: 65536,
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
   * 能力补充配置 - 当主模型缺少某能力时，使用哪个备用模型
   * 优先使用 OpenRouter 中的免费/便宜模型
   */
  private fallbackModels: Record<ModelCapability, { provider: string; model: string }> = {
    vision: { provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free' }, // 免费视觉模型
    reasoning: { provider: 'openrouter', model: 'deepseek/deepseek-r1-0528:free' }, // 免费推理模型
    code: { provider: 'deepseek', model: 'deepseek-chat' },
    fast: { provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free' },
    general: { provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free' },
    gui: { provider: 'claude', model: 'claude-sonnet-4-20250514' },
    search: { provider: 'perplexity', model: 'sonar-pro' },
  };

  /**
   * 设置能力补充的备用模型
   */
  setFallbackModel(capability: ModelCapability, provider: string, model: string): void {
    this.fallbackModels[capability] = { provider, model };
  }

  /**
   * 获取备用模型配置
   */
  getFallbackConfig(
    capability: ModelCapability,
    originalConfig: ModelConfig
  ): ModelConfig | null {
    const fallback = this.fallbackModels[capability];
    if (!fallback) return null;

    // 如果备用模型需要 API Key，检查是否有配置
    const providerConfig = PROVIDER_REGISTRY[fallback.provider];
    if (providerConfig?.requiresApiKey) {
      // OpenRouter 使用同一个 key，其他 provider 需要单独的 key
      // 这里简化处理：如果是 openrouter，复用原 config 的 apiKey（假设用户已配置 openrouter）
      // 实际使用中应该从配置服务获取对应 provider 的 key
    }

    return {
      ...originalConfig,
      provider: fallback.provider as ModelProvider,
      model: fallback.model,
    };
  }

  /**
   * 检测消息内容是否需要特定能力
   */
  detectRequiredCapabilities(messages: ModelMessage[]): ModelCapability[] {
    const capabilities: Set<ModelCapability> = new Set();

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const contentLower = content.toLowerCase();

      // 检测视觉需求：只有消息内容中真正包含图片数据时才需要视觉能力
      // 不再基于文件扩展名猜测，避免误判（如 HTML 文件名包含 .png 字样）
      if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((c) => c.type === 'image');
        if (hasImage) capabilities.add('vision');
      }

      // 检测推理需求（只在明确需要深度推理时触发，避免误判）
      // 注意："分析"太常见，会导致简单的代码分析任务也切换到 reasoning 模型
      // 而 reasoning 模型通常不支持工具调用，会导致 Agent 无法执行任务
      if (contentLower.includes('深度推理') ||
          contentLower.includes('think step by step') ||
          contentLower.includes('逐步推导') ||
          contentLower.includes('数学证明') ||
          contentLower.includes('逻辑推理')) {
        capabilities.add('reasoning');
      }
    }

    return Array.from(capabilities);
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
    // 如果启用云端代理，走云端 model-proxy
    if (config.useCloudProxy) {
      return this.callViaCloudProxy(messages, tools, config, onStream);
    }

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
      case 'openrouter':
        return this.callOpenRouter(messages, tools, config, onStream);
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

    // 根据模型能力获取推荐的 maxTokens
    const modelInfo = this.getModelInfo('deepseek', config.model || 'deepseek-chat');
    const recommendedMaxTokens = modelInfo?.maxTokens || 8192;

    // 启用流式输出
    const useStream = !!onStream;

    const requestBody: Record<string, unknown> = {
      model: config.model || 'deepseek-chat',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? recommendedMaxTokens,
      stream: useStream,
    };

    // Only add tools if we have any
    if (openaiTools.length > 0) {
      requestBody.tools = openaiTools;
      requestBody.tool_choice = 'auto';
    }

    // 如果启用流式输出，使用 SSE 处理
    if (useStream) {
      return this.callDeepSeekStream(baseUrl, requestBody, config.apiKey!, onStream!);
    }

    // 非流式输出（fallback）
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

      logger.info(' DeepSeek raw response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
      return this.parseOpenAIResponse(response.data);
    } catch (error: any) {
      if (error.response) {
        throw new Error(`DeepSeek API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw new Error(`DeepSeek request failed: ${error.message}`);
    }
  }

  /**
   * 流式调用 DeepSeek API
   * 使用 SSE (Server-Sent Events) 处理流式响应
   */
  private async callDeepSeekStream(
    baseUrl: string,
    requestBody: Record<string, unknown>,
    apiKey: string,
    onStream: StreamCallback
  ): Promise<ModelResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/chat/completions`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // 累积响应数据
      let content = '';
      let finishReason: string | undefined;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        agent: httpsAgent,
      };

      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', (chunk) => { errorData += chunk; });
          res.on('end', () => {
            reject(new Error(`DeepSeek API error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // 处理 SSE 数据行
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留不完整的行

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              if (data === '[DONE]') {
                // 流式输出完成
                const truncated = finishReason === 'length';
                const result: ModelResponse = {
                  type: toolCalls.size > 0 ? 'tool_use' : 'text',
                  content: content || undefined,
                  truncated,
                  finishReason,
                };

                if (toolCalls.size > 0) {
                  result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: this.safeJsonParse(tc.arguments),
                  }));
                }

                logger.info(' DeepSeek stream complete:', {
                  contentLength: content.length,
                  toolCallCount: toolCalls.size,
                  finishReason,
                  truncated,
                });

                if (truncated) {
                  logger.warn(' ⚠️ Output was truncated due to max_tokens limit!');
                }

                resolve(result);
                return;
              }

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta;

                // 捕获 finish_reason
                if (choice?.finish_reason) {
                  finishReason = choice.finish_reason;
                }

                if (delta) {
                  // 处理文本内容
                  if (delta.content) {
                    content += delta.content;
                    // 发送文本流式更新
                    onStream({ type: 'text', content: delta.content });
                  }

                  // 处理工具调用
                  if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const index = tc.index ?? 0;
                      const isNewToolCall = !toolCalls.has(index);

                      if (isNewToolCall) {
                        toolCalls.set(index, {
                          id: tc.id || `call_${index}`,
                          name: tc.function?.name || '',
                          arguments: '',
                        });
                        // 发送新工具调用开始事件
                        onStream({
                          type: 'tool_call_start',
                          toolCall: {
                            index,
                            id: tc.id,
                            name: tc.function?.name,
                          },
                        });
                      }

                      const existing = toolCalls.get(index)!;

                      if (tc.id && !existing.id.startsWith('call_')) {
                        existing.id = tc.id;
                      }
                      if (tc.function?.name && !existing.name) {
                        existing.name = tc.function.name;
                        // 工具名称更新
                        onStream({
                          type: 'tool_call_delta',
                          toolCall: {
                            index,
                            name: tc.function.name,
                          },
                        });
                      }
                      if (tc.function?.arguments) {
                        existing.arguments += tc.function.arguments;
                        // 发送参数增量更新
                        onStream({
                          type: 'tool_call_delta',
                          toolCall: {
                            index,
                            argumentsDelta: tc.function.arguments,
                          },
                        });
                      }
                    }
                  }
                }
              } catch (e) {
                // 忽略解析错误（可能是不完整的 JSON）
                logger.warn(' Failed to parse SSE data:', data.substring(0, 100));
              }
            }
          }
        });

        res.on('end', () => {
          // 如果没有通过 [DONE] 结束，在这里处理
          if (content || toolCalls.size > 0) {
            const result: ModelResponse = {
              type: toolCalls.size > 0 ? 'tool_use' : 'text',
              content: content || undefined,
            };

            if (toolCalls.size > 0) {
              result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: this.safeJsonParse(tc.arguments),
              }));
            }

            resolve(result);
          }
        });

        res.on('error', (error) => {
          reject(new Error(`DeepSeek stream error: ${error.message}`));
        });
      });

      req.on('error', (error) => {
        reject(new Error(`DeepSeek request error: ${error.message}`));
      });

      req.write(JSON.stringify(requestBody));
      req.end();
    });
  }

  /**
   * 安全解析 JSON，如果失败返回原始字符串
   */
  private safeJsonParse(str: string): Record<string, unknown> {
    try {
      return JSON.parse(str);
    } catch {
      logger.warn(' Failed to parse tool arguments:', str.substring(0, 200));
      return {};
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
      // Computer Use 工具的 schema 结构与标准工具定义略有不同
      // 使用类型断言以匹配 claudeTools 数组类型
      claudeTools.push({
        name: 'computer',
        description: 'Control computer screen, mouse and keyboard',
        input_schema: {
          type: 'object' as const,
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
      });
    }

    // Claude 模型使用更高的默认 maxTokens
    const requestBody: Record<string, unknown> = {
      model: config.model || 'claude-sonnet-4-20250514',
      max_tokens: config.maxTokens ?? 8192,
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

    // OpenAI 模型使用更高的默认 maxTokens
    const requestBody: Record<string, unknown> = {
      model: config.model || 'gpt-4o',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
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

    // Groq 模型使用更高的默认 maxTokens
    const requestBody: Record<string, unknown> = {
      model: config.model || 'llama-3.3-70b-versatile',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
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
          logger.error(`Failed to parse tool call arguments for ${tc.function.name}:`, parseError);
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
            logger.error(' Could not repair JSON, raw arguments:', tc.function.arguments?.substring(0, 500));
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
        logger.info(' Parsed text-based tool call:', toolName);
        return {
          type: 'tool_use',
          toolCalls: [{
            id: `text-${Date.now()}`,
            name: toolName,
            arguments: args,
          }],
        };
      } catch (e) {
        logger.error(' Failed to parse text-based tool call args:', argsStr.substring(0, 100), e);
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
        logger.info(' Successfully repaired JSON');
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

    // 智谱模型使用更高的默认 maxTokens
    const requestBody: Record<string, unknown> = {
      model: config.model || 'glm-4-flash',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
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

    // 千问模型使用更高的默认 maxTokens
    const requestBody: Record<string, unknown> = {
      model: config.model || 'qwen-max',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
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

    // Moonshot 模型使用更高的默认 maxTokens
    const requestBody: Record<string, unknown> = {
      model: config.model || 'moonshot-v1-8k',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
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
    // Perplexity 用于搜索，通常不需要太大的 maxTokens
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

  // --------------------------------------------------------------------------
  // 云端代理调用（管理员专用，服务端注入 API Key）
  // --------------------------------------------------------------------------

  private getCloudApiUrl(): string {
    return process.env.CLOUD_API_URL || 'https://code-agent-beta.vercel.app';
  }

  private async callViaCloudProxy(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const cloudUrl = this.getCloudApiUrl();
    const providerName = config.provider; // 例如 'openrouter'

    // 获取模型信息
    const modelInfo = this.getModelInfo(config.provider, config.model);
    const recommendedMaxTokens = modelInfo?.maxTokens || 8192;

    // 构建工具定义（OpenAI 兼容格式）
    const openaiTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.normalizeJsonSchema(tool.inputSchema),
      },
    }));

    // 构建请求体
    const requestBody: Record<string, unknown> = {
      model: config.model || 'google/gemini-2.0-flash-001',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? recommendedMaxTokens,
      stream: false, // 云端代理暂不支持流式
    };

    // 只有支持工具的模型才添加 tools
    if (openaiTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = openaiTools;
      requestBody.tool_choice = 'auto';
    }

    logger.info(`通过云端代理调用 ${providerName}/${config.model}...`);

    try {
      const response = await axios.post(`${cloudUrl}/api/model-proxy`, {
        provider: providerName,
        endpoint: '/chat/completions',
        body: requestBody,
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 300000,
        httpsAgent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      logger.info(' 云端代理响应状态:', response.status);

      if (response.status >= 200 && response.status < 300) {
        return this.parseOpenAIResponse(response.data);
      } else {
        throw new Error(`云端代理错误: ${response.status} - ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      if (error.response) {
        throw new Error(`云端代理 API 错误: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw new Error(`云端代理请求失败: ${error.message}`);
    }
  }

  // --------------------------------------------------------------------------
  // OpenRouter 调用（中转 Gemini、Claude、GPT 等）
  // --------------------------------------------------------------------------

  private async callOpenRouter(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';

    // OpenRouter 使用 OpenAI 兼容格式
    const openrouterTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.normalizeJsonSchema(tool.inputSchema),
      },
    }));

    // 获取模型信息
    const modelInfo = this.getModelInfo('openrouter', config.model);
    const recommendedMaxTokens = modelInfo?.maxTokens || 8192;

    // 启用流式输出
    const useStream = !!onStream;

    const requestBody: Record<string, unknown> = {
      model: config.model || 'google/gemini-2.0-flash-001',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? recommendedMaxTokens,
      stream: useStream,
    };

    // 只有支持工具的模型才添加 tools
    if (openrouterTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = openrouterTools;
      requestBody.tool_choice = 'auto';
    }

    // OpenRouter 需要额外的 headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': 'https://code-agent.app', // OpenRouter 要求
      'X-Title': 'Code Agent', // 应用名称（可选）
    };

    // 如果启用流式输出，使用 SSE 处理
    if (useStream) {
      return this.callOpenRouterStream(baseUrl, requestBody, config.apiKey!, headers, onStream!);
    }

    // 非流式输出
    try {
      const response = await axios.post(`${baseUrl}/chat/completions`, requestBody, {
        headers,
        timeout: 300000,
        httpsAgent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        responseType: 'json',
      });

      logger.info(' OpenRouter raw response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
      return this.parseOpenAIResponse(response.data);
    } catch (error: any) {
      if (error.response) {
        throw new Error(`OpenRouter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw new Error(`OpenRouter request failed: ${error.message}`);
    }
  }

  /**
   * 流式调用 OpenRouter API
   */
  private async callOpenRouterStream(
    baseUrl: string,
    requestBody: Record<string, unknown>,
    apiKey: string,
    extraHeaders: Record<string, string>,
    onStream: StreamCallback
  ): Promise<ModelResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/chat/completions`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // 累积响应数据
      let content = '';
      let finishReason: string | undefined;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
          ...extraHeaders,
        },
        agent: httpsAgent,
      };

      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', (chunk) => { errorData += chunk; });
          res.on('end', () => {
            reject(new Error(`OpenRouter API error: ${res.statusCode} - ${errorData}`));
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // 处理 SSE 数据行
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留不完整的行

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();

              if (data === '[DONE]') {
                // 流式输出完成
                const truncated = finishReason === 'length';
                const result: ModelResponse = {
                  type: toolCalls.size > 0 ? 'tool_use' : 'text',
                  content: content || undefined,
                  truncated,
                  finishReason,
                };

                if (toolCalls.size > 0) {
                  result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: this.safeJsonParse(tc.arguments),
                  }));
                }

                logger.info(' OpenRouter stream complete:', {
                  contentLength: content.length,
                  toolCallCount: toolCalls.size,
                  finishReason,
                  truncated,
                });

                resolve(result);
                return;
              }

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta;

                // 捕获 finish_reason
                if (choice?.finish_reason) {
                  finishReason = choice.finish_reason;
                }

                if (delta) {
                  // 处理文本内容
                  if (delta.content) {
                    content += delta.content;
                    onStream({ type: 'text', content: delta.content });
                  }

                  // 处理工具调用
                  if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const index = tc.index ?? 0;
                      const isNewToolCall = !toolCalls.has(index);

                      if (isNewToolCall) {
                        toolCalls.set(index, {
                          id: tc.id || `call_${index}`,
                          name: tc.function?.name || '',
                          arguments: '',
                        });
                        onStream({
                          type: 'tool_call_start',
                          toolCall: {
                            index,
                            id: tc.id,
                            name: tc.function?.name,
                          },
                        });
                      }

                      const existing = toolCalls.get(index)!;

                      if (tc.id && !existing.id.startsWith('call_')) {
                        existing.id = tc.id;
                      }
                      if (tc.function?.name && !existing.name) {
                        existing.name = tc.function.name;
                        onStream({
                          type: 'tool_call_delta',
                          toolCall: {
                            index,
                            name: tc.function.name,
                          },
                        });
                      }
                      if (tc.function?.arguments) {
                        existing.arguments += tc.function.arguments;
                        onStream({
                          type: 'tool_call_delta',
                          toolCall: {
                            index,
                            argumentsDelta: tc.function.arguments,
                          },
                        });
                      }
                    }
                  }
                }
              } catch (e) {
                logger.warn(' Failed to parse OpenRouter SSE data:', data.substring(0, 100));
              }
            }
          }
        });

        res.on('end', () => {
          if (content || toolCalls.size > 0) {
            const result: ModelResponse = {
              type: toolCalls.size > 0 ? 'tool_use' : 'text',
              content: content || undefined,
            };

            if (toolCalls.size > 0) {
              result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: this.safeJsonParse(tc.arguments),
              }));
            }

            resolve(result);
          }
        });

        res.on('error', (error) => {
          reject(new Error(`OpenRouter stream error: ${error.message}`));
        });
      });

      req.on('error', (error) => {
        reject(new Error(`OpenRouter request error: ${error.message}`));
      });

      req.write(JSON.stringify(requestBody));
      req.end();
    });
  }
}
