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
import { DEFAULT_MODELS, MODEL_API_ENDPOINTS } from '../../shared/constants';

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
}

let quickConfig: QuickModelConfig | null = null;

/**
 * 初始化 quick model：直连智谱官方 bigmodel.cn，不经过 ModelRouter。
 * 走官方是因为 0ki 代理不支持 glm-4-flash 免费 ID。
 */
function initializeQuickModel(): QuickModelConfig | null {
  if (quickConfig) return quickConfig;

  const apiKey = process.env.ZHIPU_OFFICIAL_API_KEY || process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    logger.warn('No ZHIPU_OFFICIAL_API_KEY / ZHIPU_API_KEY; quick model disabled');
    return null;
  }

  quickConfig = {
    apiKey,
    baseUrl: MODEL_API_ENDPOINTS.zhipuOfficial,
    model: DEFAULT_MODELS.quick,
  };
  logger.info('Quick model initialized', { model: quickConfig.model });
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

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: effectiveMaxTokens,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `${response.status} ${text.slice(0, 200)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.length > 0) {
      return { success: true, content };
    }
    return { success: false, error: 'Empty response from quick model' };
  } catch (error) {
    logger.error('Quick task failed', { error });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
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
    provider: 'zhipuOfficial',
    model: config.model,
  };
}
