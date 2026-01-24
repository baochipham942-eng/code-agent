// ============================================================================
// Quick Model Service - Provides fast, cheap AI for simple tasks
// ============================================================================
// Uses the quick model (cheapest, fastest) for simple operations:
// - Format conversion
// - Quick classification
// - Simple transformations
// - Yes/No decisions
// ============================================================================

import { ModelRouter } from './modelRouter';
import { getConfigService } from '../services';
import type { ModelConfig, ModelProvider } from '../../shared/types';
import { createLogger } from '../services/infra/logger';

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

let modelRouter: ModelRouter | null = null;
let quickConfig: ModelConfig | null = null;

/**
 * Initialize the quick model configuration
 * Uses the 'quick' capability fallback model
 */
function initializeQuickModel(): ModelConfig | null {
  if (quickConfig) return quickConfig;

  try {
    const configService = getConfigService();
    const settings = configService.getSettings();

    // Get base config from user settings
    const provider = (settings.model?.provider || 'deepseek') as ModelProvider;
    const baseConfig: ModelConfig = {
      provider,
      model: settings.model?.model || 'deepseek-chat',
      apiKey: '', // Will be retrieved from secure storage
      baseUrl: settings.models?.providers?.[provider]?.baseUrl,
      temperature: 0.1, // Very low temperature for deterministic outputs
      maxTokens: 512, // Short responses only
    };

    // Initialize router if needed
    if (!modelRouter) {
      modelRouter = new ModelRouter();
    }

    // Get the quick fallback model
    const fallbackConfig = modelRouter.getFallbackConfig('quick', baseConfig);

    if (fallbackConfig) {
      // Get API key for the fallback provider
      const apiKey = configService.getServiceApiKey('openrouter');
      if (apiKey) {
        quickConfig = {
          ...fallbackConfig,
          apiKey,
          temperature: 0.1,
          maxTokens: 512,
        };
        logger.info('Quick model initialized', {
          provider: quickConfig.provider,
          model: quickConfig.model,
        });
        return quickConfig;
      }
    }

    // Fallback to main model if quick not available
    logger.warn('Quick model not available, using main model');
    const mainApiKey = configService.getApiKey(baseConfig.provider);
    if (mainApiKey) {
      quickConfig = {
        ...baseConfig,
        apiKey: mainApiKey,
      };
      return quickConfig;
    }

    logger.error('No API key available for quick model');
    return null;
  } catch (error) {
    logger.error('Failed to initialize quick model', { error });
    return null;
  }
}

/**
 * Execute a quick task with the fast model
 *
 * @param prompt - The task prompt
 * @returns The result
 */
export async function quickTask(prompt: string): Promise<QuickModelResult> {
  const config = initializeQuickModel();
  if (!config) {
    return { success: false, error: 'Quick model not configured' };
  }

  if (!modelRouter) {
    modelRouter = new ModelRouter();
  }

  try {
    logger.debug('Executing quick task', {
      provider: config.provider,
      model: config.model,
      promptLength: prompt.length,
    });

    const response = await modelRouter.chat({
      provider: config.provider,
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: config.maxTokens || 512,
    });

    if (response.content) {
      return { success: true, content: response.content };
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
    provider: config.provider,
    model: config.model,
  };
}
