import type { ModelProvider } from '../types';

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
 * 新增/删除模型只需改这里，UI 自动同步
 */
export const PROVIDER_MODELS: ProviderInfo[] = [
  // 国外御三家
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT / o 系列模型',
    models: [
      { id: 'gpt-4.1', label: 'GPT-4.1 (推荐)', group: 'GPT 系列' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', group: 'GPT 系列' },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (快速)', group: 'GPT 系列' },
      { id: 'gpt-4o', label: 'GPT-4o', group: 'GPT 系列' },
      { id: 'o3', label: 'o3 (最强推理)', group: '推理模型 (o 系列)' },
      { id: 'o3-mini', label: 'o3 Mini', group: '推理模型 (o 系列)' },
      { id: 'o4-mini', label: 'o4 Mini (高性价比)', group: '推理模型 (o 系列)' },
    ],
  },
  {
    id: 'claude',
    name: 'Anthropic',
    description: 'Claude 系列模型',
    models: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (最强)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (推荐)' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (快速)' },
      { id: 'claude-opus-4-5-20251124', label: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    description: 'Google Gemini 2.5',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (推荐)' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (最便宜)' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    ],
  },
  // 国内梯队
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: '深度求索',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3.2 Chat (推荐)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek V3.2 Reasoner' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    description: 'GLM-4 系列模型',
    models: [
      { id: 'glm-5', label: 'GLM-5 (最新旗舰)' },
      { id: 'glm-4.7', label: 'GLM-4.7' },
      { id: 'glm-4.7-flash', label: 'GLM-4.7 Flash (快速)' },
      { id: 'glm-4.6v', label: 'GLM-4.6V (视觉)' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问',
    description: '阿里云 Qwen 模型',
    models: [
      { id: 'qwen3-max', label: 'Qwen3 Max (推荐)' },
      { id: 'qwen-max-latest', label: 'Qwen Max Latest' },
      { id: 'qwen-plus-latest', label: 'Qwen Plus Latest' },
      { id: 'qwen3-coder', label: 'Qwen3 Coder' },
      { id: 'qwen-vl-max', label: 'Qwen VL Max (视觉)' },
    ],
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    description: 'Moonshot AI 模型',
    models: [
      { id: 'kimi-k2.5', label: 'Kimi K2.5 (推荐)' },
      { id: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo (推荐)' },
      { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' },
      { id: 'moonshot-v1-auto', label: 'Moonshot V1 Auto' },
      { id: 'moonshot-v1-128k', label: 'Moonshot V1 128K' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax 海螺 AI',
    models: [
      { id: 'MiniMax-M2', label: 'MiniMax M2 (推荐)' },
      { id: 'MiniMax-M1', label: 'MiniMax M1' },
      { id: 'MiniMax-Text-01', label: 'MiniMax Text-01' },
      { id: 'abab7-preview', label: 'ABAB7 Preview' },
    ],
  },
  // 第三方服务
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '中转服务',
    models: [
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', group: 'Google Gemini' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', group: 'Google Gemini' },
      { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', group: 'Google Gemini' },
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude 4.5 Sonnet', group: 'Anthropic Claude' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude 4.5 Haiku', group: 'Anthropic Claude' },
      { id: 'openai/gpt-4.1', label: 'GPT-4.1', group: 'OpenAI' },
      { id: 'openai/gpt-4o', label: 'GPT-4o', group: 'OpenAI' },
      { id: 'openai/o3-mini', label: 'o3 Mini', group: 'OpenAI' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3.2', group: 'DeepSeek' },
      { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner', group: 'DeepSeek' },
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    description: 'AI 搜索服务',
    models: [
      { id: 'sonar-pro', label: 'Sonar Pro (推荐)' },
      { id: 'sonar', label: 'Sonar' },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro' },
      { id: 'sonar-reasoning', label: 'Sonar Reasoning' },
    ],
  },
];

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
