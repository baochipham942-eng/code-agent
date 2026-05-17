// ============================================================================
// Model Types
// ============================================================================

export type BuiltInModelProvider =
  | 'deepseek'
  | 'claude'
  | 'openai'
  | 'gemini'     // Google Gemini
  | 'groq'
  | 'local'
  | 'zhipu'      // 智谱 GLM
  | 'qwen'       // 通义千问
  | 'moonshot'   // Kimi
  | 'minimax'    // MiniMax
  | 'perplexity' // 联网搜索
  | 'grok'       // xAI Grok
  | 'openrouter' // OpenRouter 中转（Gemini、Claude、GPT 等）
  | 'volcengine' // 火山引擎 (豆包)
  | 'longcat'    // LongCat API 开放平台
  | 'xiaomi'     // 小米 MiMo (Token Plan 包月套餐)
  | 'custom';    // 自定义 OpenAI-compatible Provider

export type ModelProvider = BuiltInModelProvider | (string & {});

export type ModelProviderProtocol = 'openai' | 'claude';

/**
 * Provider 输入别名。
 * `anthropic` 会被规范化为内部 canonical provider `claude`。
 */
export type ModelProviderAlias = BuiltInModelProvider | 'anthropic';

// 模型能力标签
// - compact: 上下文压缩、摘要生成（便宜快速的模型）
// - quick: 简单操作、格式化、快速判断（最便宜的模型）
// - longContext: 超长上下文支持（128K+）
// - unlimited: 包月/无限制使用（不计入预算）
export type ModelCapability = 'code' | 'vision' | 'fast' | 'reasoning' | 'gui' | 'general' | 'search' | 'compact' | 'quick' | 'longContext' | 'unlimited';

/**
 * Response format configuration for structured output
 * Compatible with OpenAI's response_format parameter
 */
export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: ModelProviderProtocol;
  temperature?: number;
  maxTokens?: number;
  // 扩展配置
  capabilities?: ModelCapability[];
  computerUse?: boolean; // Claude Computer Use 支持
  // T6: Structured output support
  responseFormat?: ResponseFormat; // OpenAI-compatible response_format
  // Prompt caching (Anthropic)
  promptCaching?: {
    enabled: boolean;
    cacheSystem?: boolean;
  };
  // Extended thinking budget (tokens)
  thinkingBudget?: number;
  /**
   * OpenAI-compatible `reasoning_effort` for thinking-mode models
   * (mimo, kimi-k2.5, deepseek-reasoner, ...). Caller-level intensity hint;
   * modelRouter defaults this to 'low' on artifact generation/repair paths
   * to keep reasoning from eating the output budget.
   * For claude (which uses a numeric thinking budget), low/medium/high are
   * mapped to 4096/16384/32768 tokens by the provider when thinkingBudget
   * is not set explicitly.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** true 表示允许 adaptiveRouter 按任务复杂度切 free/default model。默认 false，严格用指定 provider/model */
  adaptive?: boolean;
}

export interface ProviderConfig {
  id: ModelProvider;
  name: string;
  models: ModelInfo[];
  requiresApiKey: boolean;
  baseUrl?: string;
  /** 智谱 Coding 套餐专用端点 */
  codingBaseUrl?: string;
}

/** 模型成本类型 */
export type ModelCostType = 'free' | 'monthly' | 'yearly' | 'payg' | 'quota';

export interface ModelInfo {
  id: string;
  name: string;
  capabilities: ModelCapability[];
  maxTokens: number;
  supportsTool: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  /** 成本类型: free=免费, monthly=包月, yearly=包年, payg=按量, quota=额度 */
  costType?: ModelCostType;
  /** 是否使用 coding 端点 (智谱 GLM-4.7) */
  useCodingEndpoint?: boolean;
  /** 支持视频输入 (Qwen-VL-Plus, Qwen-Omni) */
  supportsVideo?: boolean;
  /** 支持音频输入 (Qwen-Omni) */
  supportsAudio?: boolean;
  /** 是否为生成模型 (图像/视频生成) */
  isGenerationModel?: boolean;
  /** 生成类型 */
  generationType?: 'image' | 'video';
  /** 是否为异步模型 (视频生成) */
  isAsync?: boolean;
  /** 视觉模型能力详情 (仅当 supportsVision=true 时有效) */
  visionCapabilities?: {
    /** 支持 base64 编码图片输入 */
    supportsBase64: boolean;
    /** 支持 URL 图片输入 */
    supportsUrl: boolean;
    /** 视觉请求最大 token 限制 (可能低于 maxTokens) */
    maxVisionTokens?: number;
    /** 支持的媒体格式 */
    supportedFormats?: ('png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'mp4' | 'mp3' | 'wav')[];
    /** 备注说明 */
    note?: string;
  };
}
