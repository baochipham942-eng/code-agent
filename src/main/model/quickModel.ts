// ============================================================================
// Quick Model Service - Provides fast, cheap AI for simple tasks
// ============================================================================
// Uses the quick model (cheapest, fastest) for simple operations:
// - Format conversion
// - Quick classification
// - Simple transformations
// - Yes/No decisions
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { DEFAULT_MODELS, MODEL_API_ENDPOINTS, MODEL_FEATURES, getProviderEndpoint } from '../../shared/constants';
import { getConfigService } from '../services/core/configService';
import { getProviderLimiter } from './concurrencyLimiter';
import type { ModelProvider } from '../../shared/contract';

const logger = createLogger('QuickModel');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface QuickModelResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  reasoning?: string;
}

// ----------------------------------------------------------------------------
// Quick Model Service
// ----------------------------------------------------------------------------

interface QuickModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  /** thinking 模型（如 mimo）当 quick model 时需关闭思考，否则短输出额度被 reasoning 吃光返回空 */
  disableThinking: boolean;
}

let quickConfig: QuickModelConfig | null = null;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseChatCompletionContent(payload: unknown): string | null {
  if (!isUnknownRecord(payload) || !isUnknownArray(payload.choices)) {
    return null;
  }

  const firstChoice = payload.choices[0];
  if (!isUnknownRecord(firstChoice) || !isUnknownRecord(firstChoice.message)) {
    return null;
  }

  const content = firstChoice.message.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function isThinkingModel(model: string): boolean {
  return (MODEL_FEATURES[model] ?? []).includes('reasoning');
}

/**
 * 把一个路由角色（provider + model）解析成 quick model config。
 * 拿不到 API key 或 endpoint 时返回 null（交由上层回落）。
 * 智谱免费档走官方端点 bigmodel.cn（0ki 代理不稳定支持免费 ID）。
 */
function resolveRole(provider: string, model: string): QuickModelConfig | null {
  const cfg = getConfigService();
  const apiKey = provider === 'zhipu'
    ? cfg.getZhipuOfficialKey()
    : cfg.getApiKey(provider as ModelProvider);
  if (!apiKey) return null;

  const baseUrl = provider === 'zhipu'
    ? MODEL_API_ENDPOINTS.zhipuOfficial
    : getProviderEndpoint(provider);
  if (!baseUrl) return null;

  return { apiKey, baseUrl, model, provider, disableThinking: isThinkingModel(model) };
}

/**
 * 解析 quick model（策略化）：
 *  1) 优先专用快模型 `routing.fast`（常态 = 智谱 glm-4.x-flash，0.5s，最省成本）
 *  2) 无专用快模型 key → 回落主模型 `routing.code`（如 mimo）；thinking 模型自动关思考
 *  3) config 路径完全失败 → 兜底直连智谱官方（历史行为）
 *  4) 都拿不到 → null（调用方：intent 走关键词兜底，其余 quick 任务 skip）
 */
function initializeQuickModel(): QuickModelConfig | null {
  if (quickConfig) return quickConfig;

  let resolved: QuickModelConfig | null = null;
  try {
    const routing = getConfigService().getSettings().models.routing;
    resolved = resolveRole(routing.fast.provider, routing.fast.model)
      ?? resolveRole(routing.code.provider, routing.code.model);
  } catch (error) {
    logger.warn('Quick model config resolution failed, falling back to env', { error: String(error) });
  }

  if (!resolved) {
    const apiKey = process.env.ZHIPU_OFFICIAL_API_KEY || process.env.ZHIPU_API_KEY;
    if (apiKey) {
      resolved = {
        apiKey,
        baseUrl: MODEL_API_ENDPOINTS.zhipuOfficial,
        model: DEFAULT_MODELS.quick,
        provider: 'zhipu',
        disableThinking: false,
      };
    }
  }

  if (!resolved) {
    logger.warn('Quick model unavailable: no fast-model key, no main-model key, no Zhipu key');
    return null;
  }

  quickConfig = resolved;
  logger.info('Quick model resolved', {
    provider: resolved.provider,
    model: resolved.model,
    disableThinking: resolved.disableThinking,
  });
  return quickConfig;
}

/**
 * Execute a quick task with the fast model
 *
 * @param prompt - The task prompt
 * @returns The result
 */
export async function quickTask(prompt: string, maxTokens?: number): Promise<QuickModelResult> {
  const config = initializeQuickModel();
  if (!config) {
    return { success: false, error: 'Quick model not configured' };
  }

  const effectiveMaxTokens = maxTokens ?? 512;
  // 对声明了并发上限的 provider（如智谱）走节流；与主模型路径共用同一限流器
  const limiter = getProviderLimiter(config.provider);

  try {
    await limiter?.acquire();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: effectiveMaxTokens,
      temperature: 0.1,
      stream: false,
    };
    if (config.disableThinking) {
      body.thinking = { type: 'disabled' };
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 429 || text.includes('1302') || text.includes('速率限制')) {
        limiter?.onRateLimit();
      }
      return { success: false, error: `${response.status} ${text.slice(0, 200)}` };
    }

    limiter?.onSuccess();
    const data: unknown = await response.json();
    const content = parseChatCompletionContent(data);
    if (content) {
      return { success: true, content };
    }
    return { success: false, error: 'Empty response from quick model' };
  } catch (error) {
    logger.error('Quick task failed', { error });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    limiter?.release();
  }
}

/**
 * Quick yes/no decision
 *
 * @param question - The question to decide
 * @returns true for yes, false for no, null if unable to decide
 */
export async function quickDecision(question: string): Promise<boolean | null> {
  const prompt = `Answer the following question with only "yes" or "no", nothing else:
${question}`;

  const result = await quickTask(prompt);
  if (!result.success || !result.content) return null;

  const answer = result.content.toLowerCase().trim();
  if (answer.includes('yes')) return true;
  if (answer.includes('no')) return false;
  return null;
}

/**
 * Quick classification into predefined categories
 *
 * @param text - The text to classify
 * @param categories - The possible categories
 * @returns The classification result
 */
export async function quickClassify(
  text: string,
  categories: string[]
): Promise<ClassificationResult | null> {
  const prompt = `Classify the following text into exactly ONE of these categories: ${categories.join(', ')}

Text: "${text}"

Respond with only the category name, nothing else.`;

  const result = await quickTask(prompt);
  if (!result.success || !result.content) return null;

  const answer = result.content.trim().toLowerCase();

  // Find best matching category
  for (const category of categories) {
    if (answer.includes(category.toLowerCase())) {
      return { category, confidence: 0.9 };
    }
  }

  // If no exact match, use the first word of the response
  const firstWord = answer.split(/\s+/)[0];
  for (const category of categories) {
    if (category.toLowerCase().startsWith(firstWord)) {
      return { category, confidence: 0.6 };
    }
  }

  return null;
}

/**
 * Quick text extraction/transformation
 *
 * @param text - The source text
 * @param instruction - What to extract/transform
 * @returns The extracted/transformed text
 */
export async function quickExtract(
  text: string,
  instruction: string
): Promise<string | null> {
  const prompt = `${instruction}

Text: "${text}"

Provide only the extracted/transformed result, nothing else.`;

  const result = await quickTask(prompt);
  return result.success ? result.content || null : null;
}

/**
 * Reset the quick model configuration
 * Call this when user settings change
 */
export function resetQuickModel(): void {
  quickConfig = null;
  logger.debug('Quick model configuration reset');
}

/**
 * Check if quick model is available
 */
export function isQuickModelAvailable(): boolean {
  const config = initializeQuickModel();
  return config !== null;
}

/**
 * Get quick model info for debugging
 */
export function getQuickModelInfo(): { provider: string; model: string } | null {
  const config = initializeQuickModel();
  if (!config) return null;
  return {
    provider: config.provider,
    model: config.model,
  };
}
