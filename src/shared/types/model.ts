// ============================================================================
// Model Types
// ============================================================================

export type ModelProvider =
  | 'deepseek'
  | 'claude'
  | 'openai'
  | 'groq'
  | 'local'
  | 'zhipu'      // 智谱 GLM
  | 'qwen'       // 通义千问
  | 'moonshot'   // Kimi
  | 'perplexity' // 联网搜索
  | 'openrouter'; // OpenRouter 中转（Gemini、Claude、GPT 等）

// 模型能力标签
export type ModelCapability = 'code' | 'vision' | 'fast' | 'reasoning' | 'gui' | 'general' | 'search';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  // 扩展配置
  capabilities?: ModelCapability[];
  computerUse?: boolean; // Claude Computer Use 支持
  useCloudProxy?: boolean; // 使用云端代理（管理员专用）
}

export interface ProviderConfig {
  id: ModelProvider;
  name: string;
  models: ModelInfo[];
  requiresApiKey: boolean;
  baseUrl?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  capabilities: ModelCapability[];
  maxTokens: number;
  supportsTool: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
}
