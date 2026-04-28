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
  /** 推理模型 - DeepSeek V4 Pro (按需付费，替代 R1) */
  reasoning: 'deepseek-v4-pro',
  /** 视觉理解模型 - 智谱包年 */
  vision: 'glm-4.6v',
  /** 视觉快速模型（不支持 base64） */
  visionFast: 'glm-4.6v-flash',
  /** 代码模型 - Kimi K2.5 包月 */
  code: 'claude-sonnet-4-6',
  /** 压缩/摘要模型 - Kimi K2.5 包月无成本 */
  compact: 'kimi-k2.5',
  /** 快速判断模型 - 智谱 GLM-4.7 Flash 免费（走 bigmodel.cn，非 0ki） */
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
  'xiaomi', // 小米 MiMo（Token Plan 包月）
  'local',  // Ollama 本地模型（toy provider + 评测 baseline）
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
  // 'claude-3-5-sonnet-20241022' 已 EOL（2026-04-28 audit 清理）
} as const;

/**
 * 模型能力标签 — UI 显示 tool/vision/reasoning 标签的单一真理源。
 * 2026-04-28 audit 前散落于 ModelSwitcher.tsx，已迁移至此。
 */
export const MODEL_FEATURES: Record<string, ('tool' | 'vision' | 'reasoning')[]> = {
  // moonshot
  'kimi-k2.5': ['tool', 'reasoning'],
  'kimi-k2.6': ['tool', 'vision', 'reasoning'],
  'moonshot-v1-8k': ['tool'],
  'moonshot-v1-32k': ['tool'],
  'moonshot-v1-128k': ['tool'],
  // deepseek
  'deepseek-chat': ['tool'],
  'deepseek-coder': ['tool'],
  'deepseek-reasoner': ['reasoning'],
  // zhipu
  'glm-5': ['tool', 'reasoning'],
  'glm-5.1': ['tool', 'reasoning'],
  'glm-4.7': ['tool', 'reasoning'],
  'glm-4.7-flash': ['tool'],
  'glm-4.7-flashx': ['tool'],
  'glm-4.6v': ['vision', 'reasoning'],
  'glm-4.6v-flash': ['vision'],
  'codegeex-4': ['tool'],
  // openai
  'gpt-4o': ['tool', 'vision'],
  'gpt-4o-mini': ['tool', 'vision'],
  // claude
  'claude-opus-4-7': ['tool', 'vision', 'reasoning'],
  'claude-sonnet-4-6': ['tool', 'vision', 'reasoning'],
  'claude-haiku-4-5-20251001': ['tool', 'vision'],
  // volcengine
  'doubao-seed-1-6': ['tool', 'vision'],
  'doubao-seed-1-6-thinking': ['reasoning', 'vision'],
  'doubao-seed-1-6-flash': ['tool'],
  'doubao-seed-1-6-lite': ['tool'],
  // xiaomi MiMo（thinking-mode + tool calling）
  'mimo-v2.5-pro': ['tool', 'reasoning'],
  'mimo-v2.5': ['tool', 'reasoning'],
  'mimo-v2-pro': ['tool', 'reasoning'],
  'mimo-v2-omni': ['tool', 'vision', 'reasoning'],
  // local
  'qwen2.5-coder:7b': ['tool'],
  'qwen3:8b': ['tool'],
  'qwen3:32b': ['tool', 'reasoning'],
  'gemma4:12b': ['tool'],
  'gemma4:27b': ['tool', 'reasoning'],
  'deepseek-r1:7b': ['reasoning'],
  'deepseek-r1:32b': ['reasoning'],
  'llama4-scout:17b': ['tool', 'vision'],
  'codestral:22b': ['tool'],
};

/**
 * 模型缩写 — 状态栏 ModelIndicator 显示用。
 * 2026-04-28 audit 前散落于 ModelIndicator.tsx，已迁移至此并清理 EOL 条目。
 */
export const MODEL_ABBREV: Record<string, string> = {
  // openai
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.5-pro': '5.5-pro',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': '5.4-mini',
  'gpt-5.3-codex': '5.3-codex',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': '4o-mini',
  // claude (current)
  'claude-opus-4-7': 'opus-4.7',
  'claude-sonnet-4-6': 'sonnet-4.6',
  'claude-haiku-4-5-20251001': 'haiku-4.5',
  // deepseek
  'deepseek-v4-flash': 'v4-flash',
  'deepseek-v4-pro': 'v4-pro',
  'deepseek-chat': 'deepseek',
  'deepseek-reasoner': 'reasoner',
  // gemini
  'gemini-3.1-pro-preview': 'gemini-3.1',
  'gemini-3-flash-preview': 'gemini-3f',
  // moonshot
  'kimi-k2.5': 'kimi-2.5',
  'kimi-k2.6': 'kimi-2.6',
  // zhipu
  'glm-5.1': 'glm-5.1',
  'glm-4.7': 'glm-4.7',
  'glm-4.7-flash': 'glm-flash',
  // legacy / EOL — 保留 abbrev 防 historic session UI 退化（slice 截断）。
  // 新代码不应该再生成这些 model id；这些条目仅用于显示老会话状态栏（艾克斯 review LOW3）。
  'claude-3-5-sonnet': 'sonnet',
  'claude-3-5-sonnet-20241022': 'sonnet',
  'claude-3-opus': 'opus',
  'claude-3-opus-20240229': 'opus',
  'claude-3-haiku': 'haiku',
  'claude-3-haiku-20240307': 'haiku',
  'claude-sonnet-4-20250514': 'sonnet-4',
  'claude-opus-4-20250514': 'opus-4',
};

export function getModelAbbrev(modelId: string): string {
  return MODEL_ABBREV[modelId] ?? modelId.slice(0, 12);
}

/** 智谱视觉模型（支持 base64） */
export const ZHIPU_VISION_MODEL = 'glm-4v-plus' as const;

/**
 * visual_edit 工具专用模型配置 — 可被环境变量 override。
 * TEXT 路径：无截图时纯文本推理（source + intent）
 * VISION 路径：有截图时多模态推理（source + intent + image）
 * 默认值考虑 0ki 代理订阅的实际可用模型。
 */
export const VISUAL_EDIT_MODEL_TEXT = 'GLM-4.7' as const;
export const VISUAL_EDIT_MODEL_VISION = ZHIPU_VISION_MODEL;

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
  'deepseek-v4-flash': 'cl100k_base',
  'deepseek-v4-pro': 'cl100k_base',
  'deepseek-chat': 'cl100k_base',
  'deepseek-reasoner': 'cl100k_base',
  // Kimi / Moonshot — cl100k approximation
  'kimi-k2.6': 'cl100k_base',
  'kimi-k2.5': 'cl100k_base',
  'moonshot-v1-8k': 'cl100k_base',
  'moonshot-v1-32k': 'cl100k_base',
  'moonshot-v1-128k': 'cl100k_base',
  // 小米 MiMo — cl100k approximation（小米未公开 tokenizer，沿用通用近似）
  'mimo-v2.5-pro': 'cl100k_base',
  'mimo-v2.5': 'cl100k_base',
  'mimo-v2-pro': 'cl100k_base',
  'mimo-v2-omni': 'cl100k_base',
} as const;

/** Default tokenizer used when model is not in TOKENIZER_MAP */
export const DEFAULT_TOKENIZER = 'cl100k_base' as const;
