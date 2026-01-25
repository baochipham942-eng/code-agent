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
// Custom Error Types
// ----------------------------------------------------------------------------

/**
 * 上下文长度超限错误
 * 当请求的 token 数超过模型最大上下文限制时抛出
 */
export class ContextLengthExceededError extends Error {
  public readonly code = 'CONTEXT_LENGTH_EXCEEDED';

  constructor(
    public readonly requestedTokens: number,
    public readonly maxTokens: number,
    public readonly provider: string
  ) {
    super(`上下文长度超出限制: 请求 ${requestedTokens.toLocaleString()} tokens，最大 ${maxTokens.toLocaleString()} tokens`);
    this.name = 'ContextLengthExceededError';
  }
}

/**
 * 检测错误消息是否为上下文超限错误，并提取相关信息
 */
function parseContextLengthError(errorMessage: string, provider: string): ContextLengthExceededError | null {
  // DeepSeek 格式: "This model's maximum context length is 131072 tokens. However, you requested 5472941 tokens"
  const deepseekMatch = errorMessage.match(
    /maximum context length is (\d+).*?requested (\d+)/i
  );
  if (deepseekMatch) {
    return new ContextLengthExceededError(
      parseInt(deepseekMatch[2]),
      parseInt(deepseekMatch[1]),
      provider
    );
  }

  // OpenAI 格式: "This model's maximum context length is X tokens, however you requested Y tokens"
  const openaiMatch = errorMessage.match(
    /maximum context length is (\d+).*?you requested (\d+)/i
  );
  if (openaiMatch) {
    return new ContextLengthExceededError(
      parseInt(openaiMatch[2]),
      parseInt(openaiMatch[1]),
      provider
    );
  }

  // Claude 格式: "prompt is too long: X tokens > Y maximum"
  const claudeMatch = errorMessage.match(
    /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)/i
  );
  if (claudeMatch) {
    return new ContextLengthExceededError(
      parseInt(claudeMatch[1]),
      parseInt(claudeMatch[2]),
      provider
    );
  }

  // 通用检测：包含 "context length" 或 "token limit" 等关键词
  if (/context.?length|token.?limit|max.?tokens?.*exceeded/i.test(errorMessage)) {
    // 尝试提取数字
    const numbers = errorMessage.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      const sorted = numbers.map(n => parseInt(n)).sort((a, b) => b - a);
      return new ContextLengthExceededError(sorted[0], sorted[1], provider);
    }
  }

  return null;
}

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
    // Coding 套餐专用端点: https://open.bigmodel.cn/api/coding/paas/v4
    codingBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: [
      {
        id: 'glm-4.7',
        name: 'GLM-4.7 (Coding 套餐)',
        capabilities: ['general', 'code', 'reasoning'],
        maxTokens: 16384,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
        // 标记使用 coding 端点
        useCodingEndpoint: true,
      },
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
        maxTokens: 2048, // 实测: glm-4v-plus 实际最大只支持 2048，超过会报 1210 错误
        supportsTool: false,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'glm-4v-flash',
        name: 'GLM-4V Flash (视觉)',
        capabilities: ['vision', 'fast'],
        maxTokens: 1024, // 智谱文档: glm-4v-flash 最大只支持 1024
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
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    requiresApiKey: true,
    baseUrl: 'https://api.minimax.chat/v1',
    models: [
      {
        id: 'abab6.5s-chat',
        name: 'abab6.5s (快速)',
        capabilities: ['general', 'code', 'fast'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'abab6.5-chat',
        name: 'abab6.5',
        capabilities: ['general', 'code'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'abab5.5s-chat',
        name: 'abab5.5s (快速)',
        capabilities: ['fast', 'general'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
      {
        id: 'abab5.5-chat',
        name: 'abab5.5',
        capabilities: ['general'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: false,
        supportsStreaming: true,
      },
    ],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    requiresApiKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro (最强)',
        capabilities: ['general', 'code', 'vision', 'reasoning'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        capabilities: ['general', 'code', 'vision', 'fast'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite (最便宜)',
        capabilities: ['fast', 'general'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
        supportsStreaming: true,
      },
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        capabilities: ['general', 'code', 'vision', 'fast'],
        maxTokens: 8192,
        supportsTool: true,
        supportsVision: true,
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
    // 新增：上下文压缩和快速操作用的便宜模型
    compact: { provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free' }, // 压缩摘要
    quick: { provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free' },   // 简单操作
  };

  /**
   * 设置能力补充的备用模型
   */
  setFallbackModel(capability: ModelCapability, provider: string, model: string): void {
    this.fallbackModels[capability] = { provider, model };
  }

  /**
   * 获取备用模型配置
   * 优先使用同 provider 的能力模型（复用 API Key），其次使用默认 fallback
   */
  getFallbackConfig(
    capability: ModelCapability,
    originalConfig: ModelConfig
  ): ModelConfig | null {
    // 1. 优先检查当前 provider 是否有支持该能力的模型
    const sameProviderModel = this.findSameProviderFallback(
      originalConfig.provider,
      capability
    );
    if (sameProviderModel) {
      console.log(
        `[ModelRouter] 使用同 provider (${originalConfig.provider}) 的 ${capability} 模型: ${sameProviderModel}`
      );
      // 获取 fallback 模型的 maxTokens 限制
      const fallbackModelInfo = this.getModelInfo(originalConfig.provider, sameProviderModel);
      return {
        ...originalConfig,
        model: sameProviderModel,
        // 使用 fallback 模型的 maxTokens，避免超过限制
        maxTokens: fallbackModelInfo?.maxTokens || 1024,
      };
    }

    // 2. 使用默认 fallback 配置
    const fallback = this.fallbackModels[capability];
    if (!fallback) return null;

    console.log(
      `[ModelRouter] 使用默认 fallback: ${fallback.provider}/${fallback.model}`
    );

    // 获取 fallback 模型的 maxTokens 限制
    const fallbackModelInfo = this.getModelInfo(fallback.provider, fallback.model);
    return {
      ...originalConfig,
      provider: fallback.provider as ModelProvider,
      model: fallback.model,
      // 使用 fallback 模型的 maxTokens，避免超过限制
      maxTokens: fallbackModelInfo?.maxTokens || 1024,
    };
  }

  /**
   * 查找同 provider 中支持指定能力的模型
   * 返回模型 ID，如果没有找到返回 null
   */
  private findSameProviderFallback(
    provider: ModelProvider,
    capability: ModelCapability
  ): string | null {
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) return null;

    // 根据能力类型查找对应的模型
    // 优先选择快速/便宜的模型
    const capabilityToFlag: Partial<Record<ModelCapability, keyof typeof providerConfig.models[0]>> = {
      vision: 'supportsVision',
      // 其他能力可以扩展
    };

    const flag = capabilityToFlag[capability];
    if (!flag) return null;

    // 查找支持该能力的模型
    // 注意：智谱 glm-4v-flash 不支持 base64 编码，必须排除
    const supportingModels = providerConfig.models.filter(
      (m) => m[flag] === true && m.id !== 'glm-4v-flash' // 排除不支持 base64 的模型
    );

    if (supportingModels.length === 0) return null;

    // 优先返回快速/便宜模型（但已排除 glm-4v-flash）
    const fastModel = supportingModels.find(
      (m) =>
        m.id.toLowerCase().includes('flash') ||
        m.id.toLowerCase().includes('fast') ||
        m.id.toLowerCase().includes('mini')
    );

    return fastModel?.id || supportingModels[0].id;
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
        if (hasImage) {
          // 检查是否是标注请求 - 如果用户想要在图片上画框/标注，应该使用主模型+工具
          // 而不是 fallback 到视觉模型（视觉模型不支持工具调用）
          const annotationKeywords = ['框', '圈', '标注', '标记', '画', 'annotate', 'mark', 'highlight', 'box'];
          const isAnnotationRequest = annotationKeywords.some(kw => contentLower.includes(kw));

          if (!isAnnotationRequest) {
            // 纯图片理解请求，需要视觉能力
            capabilities.add('vision');
          }
          // 如果是标注请求，不添加 vision capability，让主模型处理并调用 image_annotate 工具
        }
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
   * 简便方法：纯文本对话（无工具调用）
   * 适用于研究模式等只需要文本生成的场景
   */
  async chat(options: {
    provider: ModelProvider;
    model: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string | null }> {
    const config: ModelConfig = {
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens ?? 2000,
    };

    const response = await this.inference(
      options.messages as ModelMessage[],
      [],
      config
    );

    return { content: response.content ?? null };
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
      case 'gemini':
        return this.callGemini(messages, tools, config, onStream);
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
      case 'minimax':
        return this.callMinimax(messages, tools, config, onStream);
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

    // T6: Add response_format for structured output
    if (config.responseFormat) {
      requestBody.response_format = config.responseFormat;
      logger.debug(' DeepSeek: Using response_format:', config.responseFormat.type);
    }

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
        const errorData = error.response.data;
        const errorMessage = typeof errorData === 'string'
          ? errorData
          : JSON.stringify(errorData);

        // 检测上下文超限错误
        const contextError = parseContextLengthError(errorMessage, 'deepseek');
        if (contextError) {
          throw contextError;
        }

        throw new Error(`DeepSeek API error: ${error.response.status} - ${errorMessage}`);
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
              } catch {
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
   * 安全解析 JSON，支持多级备份提取策略
   *
   * 流式响应中，工具调用的 arguments 可能分散在多个 chunk 中，
   * 有时会出现：
   * 1. JSON 不完整（被截断）
   * 2. JSON 格式错误（额外字符、未闭合）
   * 3. 部分字段缺失
   *
   * 备份提取策略：
   * 1. 直接解析 JSON
   * 2. 尝试修复常见 JSON 问题后重新解析
   * 3. 从原始字符串中提取键值对
   */
  private safeJsonParse(str: string): Record<string, unknown> {
    // 策略 1: 直接解析
    try {
      const result = JSON.parse(str);
      logger.debug('[safeJsonParse] Direct parse succeeded');
      return result;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown parse error';
      logger.debug(`[safeJsonParse] Direct parse failed: ${errorMessage}, trying repair strategies...`);
    }

    // 策略 2: 修复常见 JSON 问题
    const repaired = this.repairJsonForArguments(str);
    if (repaired) {
      logger.info('[safeJsonParse] Repaired JSON parse succeeded');
      return repaired;
    }

    // 策略 3: 从原始字符串提取键值对
    const extracted = this.extractKeyValuePairs(str);
    if (extracted && Object.keys(extracted).length > 0) {
      logger.info('[safeJsonParse] Extracted key-value pairs:', Object.keys(extracted).join(', '));
      return extracted;
    }

    // 所有策略失败，返回包含解析错误信息的对象
    logger.warn('[safeJsonParse] All parse strategies failed');
    logger.warn(`[safeJsonParse] Raw arguments (first 500 chars): ${str.substring(0, 500)}`);
    return {
      __parseError: true,
      __errorMessage: 'All JSON parse strategies failed',
      __rawArguments: str.substring(0, 1000), // 限制大小
    };
  }

  /**
   * 修复常见的 JSON 问题用于 arguments 解析
   * 专门针对流式响应中可能出现的问题
   */
  private repairJsonForArguments(str: string): Record<string, unknown> | null {
    if (!str || !str.trim()) return null;

    let repaired = str.trim();

    // 1. 移除开头的非 JSON 字符（如换行、空格、注释）
    repaired = repaired.replace(/^[^{\[]*/, '');

    // 2. 移除结尾的非 JSON 字符
    repaired = repaired.replace(/[^}\]]*$/, '');

    // 3. 如果没有找到 JSON 结构，返回 null
    if (!repaired.startsWith('{') && !repaired.startsWith('[')) {
      return null;
    }

    // 4. 尝试修复未闭合的 JSON
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

      if (char === '"' && !escapeNext) {
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

    // 5. 关闭未闭合的字符串
    if (inString) {
      repaired += '"';
    }

    // 6. 关闭未闭合的括号
    while (bracketCount > 0) {
      repaired += ']';
      bracketCount--;
    }

    while (braceCount > 0) {
      repaired += '}';
      braceCount--;
    }

    // 7. 尝试解析修复后的 JSON
    try {
      return JSON.parse(repaired);
    } catch {
      // 8. 尝试更激进的修复：截断到最后一个完整的键值对
      const lastComma = repaired.lastIndexOf(',');
      if (lastComma > 0) {
        const truncated = repaired.substring(0, lastComma) + '}';
        try {
          return JSON.parse(truncated);
        } catch {
          // 继续尝试其他方法
        }
      }

      return null;
    }
  }

  /**
   * 从原始字符串提取键值对
   * 作为最后的备份方案，用正则表达式提取可识别的字段
   */
  private extractKeyValuePairs(str: string): Record<string, unknown> | null {
    if (!str || !str.trim()) return null;

    const result: Record<string, unknown> = {};

    // 提取常见的工具参数字段
    // 匹配 "key": "value" 或 "key": value
    const stringPattern = /"(\w+)":\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    const numberPattern = /"(\w+)":\s*(-?\d+\.?\d*)/g;
    const booleanPattern = /"(\w+)":\s*(true|false)/g;
    const nullPattern = /"(\w+)":\s*null/g;

    // 提取字符串值
    let match;
    while ((match = stringPattern.exec(str)) !== null) {
      result[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    // 提取数字值
    while ((match = numberPattern.exec(str)) !== null) {
      if (!(match[1] in result)) {  // 不覆盖已有的字符串值
        result[match[1]] = parseFloat(match[2]);
      }
    }

    // 提取布尔值
    while ((match = booleanPattern.exec(str)) !== null) {
      if (!(match[1] in result)) {
        result[match[1]] = match[2] === 'true';
      }
    }

    // 提取 null 值
    while ((match = nullPattern.exec(str)) !== null) {
      if (!(match[1] in result)) {
        result[match[1]] = null;
      }
    }

    // 尝试提取数组（简化版，只处理单层）
    const arrayPattern = /"(\w+)":\s*\[([^\]]*)\]/g;
    while ((match = arrayPattern.exec(str)) !== null) {
      if (!(match[1] in result)) {
        try {
          result[match[1]] = JSON.parse(`[${match[2]}]`);
        } catch {
          // 如果数组解析失败，尝试分割字符串
          result[match[1]] = match[2].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
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
    _onStream?: StreamCallback
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
    _onStream?: StreamCallback
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

    // T6: Add response_format for structured output
    if (config.responseFormat) {
      requestBody.response_format = config.responseFormat;
      logger.debug(' OpenAI: Using response_format:', config.responseFormat.type);
    }

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

  // --------------------------------------------------------------------------
  // Google Gemini 调用
  // --------------------------------------------------------------------------

  private async callGemini(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const model = config.model || 'gemini-2.5-flash';

    // 转换消息为 Gemini 格式
    const geminiContents = this.convertToGeminiMessages(messages);

    // 转换工具为 Gemini 格式
    const geminiTools = tools.length > 0 ? [{
      function_declarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    }] : undefined;

    const requestBody: Record<string, unknown> = {
      contents: geminiContents,
      generationConfig: {
        temperature: config.temperature ?? 0.7,
        maxOutputTokens: config.maxTokens ?? 8192,
      },
    };

    if (geminiTools) {
      requestBody.tools = geminiTools;
    }

    const endpoint = onStream ? 'streamGenerateContent' : 'generateContent';
    const url = `${baseUrl}/models/${model}:${endpoint}?key=${config.apiKey}`;

    const response = await electronFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return this.handleGeminiStream(response.body, onStream);
    }

    const data = await response.json();
    return this.parseGeminiResponse(data);
  }

  private convertToGeminiMessages(messages: ModelMessage[]): any[] {
    const contents: any[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        // Gemini 使用 system_instruction，这里作为第一个 user 消息处理
        contents.push({
          role: 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
        });
        contents.push({
          role: 'model',
          parts: [{ text: 'Understood. I will follow these instructions.' }],
        });
      } else if (m.role === 'user' || m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        });
      } else if (m.role === 'assistant') {
        contents.push({
          role: 'model',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        });
      }
    }

    return contents;
  }

  private async handleGeminiStream(
    body: ReadableStream<Uint8Array>,
    onStream: StreamCallback
  ): Promise<ModelResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Gemini 流式返回的是 JSON 数组片段
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith('data: [DONE]')) continue;

          try {
            const cleanLine = line.replace(/^data:\s*/, '');
            if (!cleanLine) continue;

            const json = JSON.parse(cleanLine);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              fullContent += text;
              onStream({ type: 'text', content: text });
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { type: 'text', content: fullContent, toolCalls: [] };
  }

  private parseGeminiResponse(data: any): ModelResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('No response from Gemini');
    }

    const content = candidate.content?.parts?.[0]?.text || '';
    const toolCalls: ToolCall[] = [];

    // 处理函数调用
    const functionCalls = candidate.content?.parts?.filter((p: any) => p.functionCall);
    if (functionCalls?.length > 0) {
      for (const fc of functionCalls) {
        toolCalls.push({
          id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: fc.functionCall.name,
          arguments: fc.functionCall.args || {},
        });
      }
    }

    return {
      type: toolCalls.length > 0 ? 'tool_use' : 'text',
      content,
      toolCalls,
    };
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
      // 提供更详细的错误信息
      const dataPreview = JSON.stringify(data).substring(0, 200);
      logger.error('[parseOpenAIResponse] No choices in response:', dataPreview);
      throw new Error(`No response from model. Response: ${dataPreview}`);
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
    console.log(`📡 [ZHIPU-CALL] 进入智谱调用, model=${config.model}, hasApiKey=${!!config.apiKey}, useCloudProxy=${config.useCloudProxy}`);
    // 检查模型是否需要使用 Coding 端点
    const modelInfo = this.getModelInfo('zhipu', config.model);
    const providerConfig = PROVIDER_REGISTRY.zhipu;

    // GLM-4.7 等 Coding 套餐模型使用专用端点
    let baseUrl: string;
    if (modelInfo?.useCodingEndpoint && providerConfig.codingBaseUrl) {
      baseUrl = providerConfig.codingBaseUrl;
      logger.info(`[智谱] 使用 Coding 套餐端点: ${baseUrl}, 模型: ${config.model}`);
    } else {
      baseUrl = config.baseUrl || providerConfig.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
      logger.info(`[智谱] 使用标准端点: ${baseUrl}, 模型: ${config.model}`);
    }

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
    // 注意：智谱 API 总是使用流式响应，即使 stream: false 也返回 chunk 格式
    // 所以我们总是启用流式处理
    const requestBody: Record<string, unknown> = {
      model: config.model || 'glm-4.7',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
      stream: true, // 智谱总是使用流式
    };

    // 检查模型是否支持工具调用
    if (zhipuTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = zhipuTools;
      requestBody.tool_choice = 'auto';
    }

    logger.info(`[智谱] 请求: model=${requestBody.model}, max_tokens=${requestBody.max_tokens}, stream=true`);
    logger.debug(`[智谱] 完整请求体:`, JSON.stringify(requestBody).substring(0, 500));

    // 使用原生 https 模块处理流式响应（electronFetch 基于 axios 不支持流式 body）
    return this.callZhipuStream(baseUrl, requestBody, config.apiKey!, onStream);
  }

  /**
   * 智谱流式 API 调用（使用原生 https 模块）
   */
  private async callZhipuStream(
    baseUrl: string,
    requestBody: Record<string, unknown>,
    apiKey: string,
    onStream?: StreamCallback
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

      logger.debug(`[智谱] 发起请求到: ${url.hostname}${url.pathname}`);

      const req = httpModule.request(options, (res) => {
        logger.debug(`[智谱] 响应状态码: ${res.statusCode}`);

        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', (chunk) => { errorData += chunk; });
          res.on('end', () => {
            logger.error(`[智谱] API 错误: ${res.statusCode}`, errorData);
            // 尝试解析错误信息，提供更友好的提示
            let errorMessage = `智谱 API 错误 (${res.statusCode})`;
            try {
              const parsed = JSON.parse(errorData);
              if (parsed.error?.message) {
                errorMessage = `智谱 API: ${parsed.error.message}`;
                // 对常见错误码提供额外说明
                if (parsed.error.code === '1210') {
                  errorMessage += ' (请检查模型是否支持当前请求参数)';
                }
              }
            } catch {
              // 解析失败，使用原始数据
              errorMessage = `智谱 API error: ${res.statusCode} - ${errorData}`;
            }
            reject(new Error(errorMessage));
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

                logger.info('[智谱] stream complete:', {
                  contentLength: content.length,
                  toolCallCount: toolCalls.size,
                  finishReason,
                  truncated,
                });

                if (truncated) {
                  logger.warn('[智谱] ⚠️ Output was truncated due to max_tokens limit!');
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
                    logger.debug(`[智谱] 收到文本块: "${delta.content.substring(0, 30)}..."`);
                    // 发送文本流式更新
                    if (onStream) {
                      onStream({ type: 'text', content: delta.content });
                    }
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
                        if (onStream) {
                          onStream({
                            type: 'tool_call_start',
                            toolCall: {
                              index,
                              id: tc.id || `call_${index}`,
                              name: tc.function?.name || '',
                            },
                          });
                        }
                      }

                      // 累积参数
                      if (tc.function?.arguments) {
                        const existing = toolCalls.get(index)!;
                        existing.arguments += tc.function.arguments;
                        // 发送参数流式更新
                        if (onStream) {
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
                }
              } catch {
                // 忽略解析错误，继续处理下一行
              }
            }
          }
        });

        res.on('end', () => {
          // 如果没有收到 [DONE]，也返回结果
          if (content || toolCalls.size > 0) {
            const result: ModelResponse = {
              type: toolCalls.size > 0 ? 'tool_use' : 'text',
              content: content || undefined,
              finishReason,
            };

            if (toolCalls.size > 0) {
              result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: this.safeJsonParse(tc.arguments),
              }));
            }

            resolve(result);
          } else {
            reject(new Error('[智谱] 流式响应无内容'));
          }
        });

        res.on('error', (err) => {
          logger.error('[智谱] 响应错误:', err);
          reject(err);
        });
      });

      req.on('error', (err) => {
        logger.error('[智谱] 请求错误:', err);
        reject(err);
      });

      req.write(JSON.stringify(requestBody));
      req.end();
    });
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
  // MiniMax 调用
  // --------------------------------------------------------------------------

  private async callMinimax(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || 'https://api.minimax.chat/v1';

    // MiniMax 使用 OpenAI 兼容格式
    const minimaxTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const requestBody: Record<string, unknown> = {
      model: config.model || 'abab6.5s-chat',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 8192,
      stream: !!onStream,
    };

    const modelInfo = this.getModelInfo('minimax', config.model);
    if (minimaxTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = minimaxTools;
      requestBody.tool_choice = 'auto';
    }

    const response = await electronFetch(`${baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error: ${response.status} - ${error}`);
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

    // 启用流式输出当有回调时
    const useStream = !!onStream;

    // 构建请求体
    const requestBody: Record<string, unknown> = {
      model: config.model || 'google/gemini-2.0-flash-001',
      messages: this.convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? recommendedMaxTokens,
      stream: useStream,
    };

    // T6: Add response_format for structured output
    if (config.responseFormat) {
      requestBody.response_format = config.responseFormat;
      logger.debug(' Cloud Proxy: Using response_format:', config.responseFormat.type);
    }

    // 只有支持工具的模型才添加 tools
    if (openaiTools.length > 0 && modelInfo?.supportsTool) {
      requestBody.tools = openaiTools;
      requestBody.tool_choice = 'auto';
    }

    logger.info(`通过云端代理调用 ${providerName}/${config.model}...`, { streaming: useStream });

    try {
      // 流式请求
      if (useStream) {
        return await this.callViaCloudProxyStreaming(cloudUrl, providerName, requestBody, onStream);
      }

      // 非流式请求
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
        const errorMessage = JSON.stringify(response.data);
        // 检测上下文超限错误
        const contextError = parseContextLengthError(errorMessage, 'cloud-proxy');
        if (contextError) {
          throw contextError;
        }
        throw new Error(`云端代理错误: ${response.status} - ${errorMessage}`);
      }
    } catch (error: any) {
      // 如果已经是 ContextLengthExceededError，直接抛出
      if (error instanceof ContextLengthExceededError) {
        throw error;
      }

      if (error.response) {
        const errorMessage = JSON.stringify(error.response.data);
        // 检测上下文超限错误
        const contextError = parseContextLengthError(errorMessage, 'cloud-proxy');
        if (contextError) {
          throw contextError;
        }
        throw new Error(`云端代理 API 错误: ${error.response.status} - ${errorMessage}`);
      }
      throw new Error(`云端代理请求失败: ${error.message}`);
    }
  }

  /**
   * 通过云端代理进行流式调用
   */
  private async callViaCloudProxyStreaming(
    cloudUrl: string,
    providerName: string,
    requestBody: Record<string, unknown>,
    onStream: StreamCallback
  ): Promise<ModelResponse> {
    const response = await fetch(`${cloudUrl}/api/model-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: providerName,
        endpoint: '/chat/completions',
        body: requestBody,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`云端代理流式错误: ${response.status} - ${errorText}`);
    }

    if (!response.body) {
      throw new Error('云端代理流式响应无 body');
    }

    // 解析 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let fullContent = '';
    const toolCalls: ToolCall[] = [];
    const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();

    try {
      let buffer = '';
      logger.debug('[云端代理] 开始读取流式响应...');

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          logger.debug('[云端代理] 流式响应读取完成, fullContent长度:', fullContent.length);
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // 处理 SSE 数据行
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留未完成的行

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            logger.debug('[云端代理] 收到 [DONE] 标记');
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (!delta) {
              logger.debug('[云端代理] delta 为空, parsed:', JSON.stringify(parsed).substring(0, 200));
              continue;
            }

            // 文本内容
            if (delta.content) {
              fullContent += delta.content;
              logger.debug('[云端代理] 收到文本块:', delta.content.substring(0, 50));
              onStream({ type: 'text', content: delta.content });
            }

            // 工具调用
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;

                if (!toolCallsInProgress.has(index)) {
                  // 新工具调用开始
                  toolCallsInProgress.set(index, {
                    id: tc.id || `tool-${index}`,
                    name: tc.function?.name || '',
                    arguments: '',
                  });
                  onStream({
                    type: 'tool_call_start',
                    toolCall: { index, id: tc.id, name: tc.function?.name },
                  });
                }

                const inProgress = toolCallsInProgress.get(index)!;

                // 更新名称
                if (tc.function?.name) {
                  inProgress.name = tc.function.name;
                }

                // 累积参数
                if (tc.function?.arguments) {
                  inProgress.arguments += tc.function.arguments;
                  onStream({
                    type: 'tool_call_delta',
                    toolCall: { index, name: inProgress.name, argumentsDelta: tc.function.arguments },
                  });
                }
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      // 完成工具调用
      for (const [, tc] of toolCallsInProgress) {
        try {
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments || '{}'),
          });
        } catch {
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: {},
          });
        }
      }

      // 返回结果
      if (toolCalls.length > 0) {
        return { type: 'tool_use', toolCalls };
      }

      return { type: 'text', content: fullContent };
    } finally {
      reader.releaseLock();
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

    // T6: Add response_format for structured output
    if (config.responseFormat) {
      requestBody.response_format = config.responseFormat;
      logger.debug(' OpenRouter: Using response_format:', config.responseFormat.type);
    }

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
              } catch {
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
