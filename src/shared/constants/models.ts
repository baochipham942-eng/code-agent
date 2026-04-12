import type { ModelProvider } from '../contract';
import catalog from '../model-catalog.json';

/** 模型配置 */
export const MODEL = {
  /** 默认 max_tokens — 与 MODEL_MAX_TOKENS.DEFAULT 保持一致 */
  DEFAULT_MAX_TOKENS: 16384,
  /** 默认 temperature */
  DEFAULT_TEMPERATURE: 0.7,
  /** 流式响应块大小 */
  STREAM_CHUNK_SIZE: 1024,
  /** 上下文窗口安全边际 */
  CONTEXT_SAFETY_MARGIN: 1000,
} as const;

/** 默认模型配置 */
export const DEFAULT_MODELS = {
  /** 主要对话模型 - Kimi K2.5 包月 */
  chat: 'claude-sonnet-4-6',
  /** 推理模型 - DeepSeek R1 (按需付费) */
  reasoning: 'deepseek-reasoner',
  /** 视觉理解模型 - 智谱包年 */
  vision: 'glm-4.6v',
  /** 视觉快速模型（不支持 base64） */
  visionFast: 'glm-4.6v-flash',
  /** 代码模型 - Kimi K2.5 包月 */
  code: 'claude-sonnet-4-6',
  /** 压缩/摘要模型 - Kimi K2.5 包月无成本 */
  compact: 'kimi-k2.5',
  /** 快速判断模型 - 智谱 Flash 包年免费 */
  quick: 'glm-4.7-flash',
  /** 超长上下文模型（128K+） */
  longContext: 'claude-sonnet-4-6',
  /** 包月无限制模型 */
  unlimited: 'claude-sonnet-4-6',
} as const;

/** Agent 子任务默认模型（包月无限制，适合高频调用） */
export const AGENT_DEFAULT_MODEL = {
  provider: 'moonshot',
  model: DEFAULT_MODELS.compact,
} as const;

export interface ProviderModelEntry {
  id: string;
  label: string;
  group?: string; // optgroup label（同一 provider 内分组）
}

export interface ProviderInfo {
  id: ModelProvider;
  name: string;
  description: string;
  models: ProviderModelEntry[];
}

/**
 * 所有 Provider 及其可选模型 — Settings 页面的唯一数据源
 * 数据来源: ~/Downloads/ai/model-catalog.json（中央模型目录）
 * 更新模型后运行 ~/Downloads/ai/sync-models.sh 同步
 */
const SUPPORTED_PROVIDERS = new Set<string>([
  'openai', 'claude', 'gemini', 'deepseek', 'zhipu',
  'qwen', 'moonshot', 'minimax', 'openrouter', 'perplexity',
]);

export const PROVIDER_MODELS: ProviderInfo[] = catalog.providers
  .filter((p) => SUPPORTED_PROVIDERS.has(p.id))
  .map((p) => ({
    id: p.id as ModelProvider,
    name: p.name,
    description: p.description,
    models: p.models.map((m) => ({
      id: m.id,
      label: m.label,
      ...('group' in m && m.group ? { group: m.group } : {}),
    })),
  }));

/** 按 provider ID 快速查找 */
export const PROVIDER_MODELS_MAP: Record<string, ProviderInfo> = Object.fromEntries(
  PROVIDER_MODELS.map((p) => [p.id, p])
);

export const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  PROVIDER_MODELS.flatMap((provider) =>
    provider.models.map((model) => [model.id, model.label] as const)
  )
);

export function getModelDisplayLabel(modelId: string): string {
  return MODEL_LABELS[modelId] ?? modelId;
}

/** 视觉模型能力详情 */
export const VISION_MODEL_CAPABILITIES: Record<string, {
  supportsBase64: boolean;
  supportsUrl: boolean;
  maxTokens: number;
  note: string;
}> = {
  'glm-4.6v': {
    supportsBase64: true,
    supportsUrl: true,
    maxTokens: 2048, // 实测限制
    note: '智谱视觉模型，支持 base64 和 URL',
  },
  'glm-4.6v-flash': {
    supportsBase64: false,
    supportsUrl: true,
    maxTokens: 1024, // 文档限制
    note: '智谱快速视觉模型，仅支持 URL',
  },
  'gpt-4o': {
    supportsBase64: true,
    supportsUrl: true,
    maxTokens: 4096,
    note: 'OpenAI 视觉模型',
  },
  'claude-3-5-sonnet-20241022': {
    supportsBase64: true,
    supportsUrl: false,
    maxTokens: 8192,
    note: 'Claude 视觉模型，仅支持 base64',
  },
} as const;

/** 智谱视觉模型（支持 base64） */
export const ZHIPU_VISION_MODEL = 'glm-4v-plus' as const;

/** Mermaid 在线渲染 API */
export const MERMAID_INK_API = 'https://mermaid.ink';

/**
 * Model ID → tokenizer family mapping.
 * GPT-family models (OpenAI, Claude via cl100k approximation, etc.) all use
 * the same BPE vocabulary in gpt-tokenizer.  Extend this map when new
 * tokenizer families are added.
 */
export const TOKENIZER_MAP: Record<string, 'cl100k_base' | 'o200k_base'> = {
  // OpenAI GPT-4 / GPT-3.5 family
  'gpt-4': 'cl100k_base',
  'gpt-4-turbo': 'cl100k_base',
  'gpt-4o': 'o200k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  // Claude — approximated with cl100k (closest public BPE)
  'claude-3-5-sonnet-20241022': 'cl100k_base',
  'claude-sonnet-4-6': 'cl100k_base',
  // DeepSeek — cl100k approximation
  'deepseek-chat': 'cl100k_base',
  'deepseek-reasoner': 'cl100k_base',
  // Kimi / Moonshot — cl100k approximation
  'kimi-k2.5': 'cl100k_base',
  'moonshot-v1-8k': 'cl100k_base',
  'moonshot-v1-32k': 'cl100k_base',
  'moonshot-v1-128k': 'cl100k_base',
} as const;

/** Default tokenizer used when model is not in TOKENIZER_MAP */
export const DEFAULT_TOKENIZER = 'cl100k_base' as const;
