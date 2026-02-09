// ============================================================================
// Compact Model Service - Provides AI summarization for context compression
// ============================================================================
// Uses the compact model (cheap, fast) for context compression tasks:
// - Conversation summarization
// - Token reduction
// - Information extraction
// ============================================================================

import { ModelRouter } from '../model/modelRouter';
import { getConfigService } from '../services';
import type { ModelConfig, ModelProvider } from '../../shared/types';
import { createLogger } from '../services/infra/logger';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../shared/constants';

const logger = createLogger('CompactModel');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface CompactModelOptions {
  maxTokens?: number;
  temperature?: number;
}

// ----------------------------------------------------------------------------
// Compact Model Service
// ----------------------------------------------------------------------------

let modelRouter: ModelRouter | null = null;
let compactConfig: ModelConfig | null = null;

/**
 * Initialize the compact model configuration
 * Uses the 'compact' capability fallback model
 */
function initializeCompactModel(): ModelConfig | null {
  if (compactConfig) return compactConfig;

  try {
    const configService = getConfigService();
    const settings = configService.getSettings();

    // Get base config from user settings
    const provider = (settings.model?.provider || DEFAULT_PROVIDER) as ModelProvider;
    const baseConfig: ModelConfig = {
      provider,
      model: settings.model?.model || DEFAULT_MODELS.chat,
      apiKey: '', // Will be retrieved from secure storage
      baseUrl: settings.models?.providers?.[provider]?.baseUrl,
      temperature: 0.3, // Lower temperature for consistent summaries
      maxTokens: 2048,
    };

    // Initialize router if needed
    if (!modelRouter) {
      modelRouter = new ModelRouter();
    }

    // Get the compact fallback model
    const fallbackConfig = modelRouter.getFallbackConfig('compact', baseConfig);

    if (fallbackConfig) {
      // Get API key for the fallback provider
      const apiKey = configService.getServiceApiKey('openrouter');
      if (apiKey) {
        compactConfig = {
          ...fallbackConfig,
          apiKey,
          temperature: 0.3,
          maxTokens: 2048,
        };
        logger.info('Compact model initialized', {
          provider: compactConfig.provider,
          model: compactConfig.model,
        });
        return compactConfig;
      }
    }

    // Fallback to main model if compact not available
    logger.warn('Compact model not available, using main model for summarization');
    const mainApiKey = configService.getApiKey(baseConfig.provider);
    if (mainApiKey) {
      compactConfig = {
        ...baseConfig,
        apiKey: mainApiKey,
      };
      return compactConfig;
    }

    logger.error('No API key available for summarization');
    return null;
  } catch (error) {
    logger.error('Failed to initialize compact model', { error });
    return null;
  }
}

/**
 * Generate AI summary using compact model
 * This function is designed to be passed to the summarizer
 *
 * @param prompt - The summarization prompt
 * @param maxTokens - Maximum tokens for the response
 * @param options - Optional: useMainModel forces main model, instructions overrides default prompt
 * @returns The generated summary text
 */
export async function compactModelSummarize(
  prompt: string,
  maxTokens: number,
  options?: {
    /** 使用主模型做摘要（而非 cheap model），理解上下文更好 */
    useMainModel?: boolean;
    /** 自定义摘要指令，覆盖默认 prompt */
    instructions?: string;
  }
): Promise<string> {
  // 如果提供了自定义指令，替换 prompt 中的默认指令部分
  const finalPrompt = options?.instructions
    ? prompt.replace(/^.*?(?=\n\n对话历史：)/s, options.instructions)
    : prompt;

  let config: ModelConfig | null;

  if (options?.useMainModel) {
    // 使用主模型：理解上下文更好，适合高质量摘要
    config = initializeMainModel();
  } else {
    config = initializeCompactModel();
  }

  if (!config) {
    throw new Error('Compact model not configured');
  }

  if (!modelRouter) {
    modelRouter = new ModelRouter();
  }

  try {
    logger.debug('Generating summary', {
      provider: config.provider,
      model: config.model,
      promptLength: finalPrompt.length,
      maxTokens,
      useMainModel: !!options?.useMainModel,
    });

    const response = await modelRouter.chat({
      provider: config.provider,
      model: config.model,
      messages: [{ role: 'user', content: finalPrompt }],
      maxTokens: Math.min(maxTokens, config.maxTokens || 2048),
    });

    if (response.content) {
      logger.debug('Summary generated', {
        responseLength: response.content.length,
      });
      return response.content;
    }

    throw new Error('Empty response from compact model');
  } catch (error) {
    logger.error('Failed to generate summary', { error });
    throw error;
  }
}

/**
 * Initialize main model for high-quality summarization
 */
function initializeMainModel(): ModelConfig | null {
  try {
    const configService = getConfigService();
    const settings = configService.getSettings();

    const provider = (settings.model?.provider || DEFAULT_PROVIDER) as ModelProvider;
    const apiKey = configService.getApiKey(provider);

    if (!apiKey) {
      logger.warn('No API key available for main model summarization');
      return null;
    }

    return {
      provider,
      model: settings.model?.model || DEFAULT_MODELS.chat,
      apiKey,
      baseUrl: settings.models?.providers?.[provider]?.baseUrl,
      temperature: 0.3,
      maxTokens: 2048,
    };
  } catch (error) {
    logger.error('Failed to initialize main model for summarization', { error });
    return null;
  }
}

/**
 * Reset the compact model configuration
 * Call this when user settings change
 */
export function resetCompactModel(): void {
  compactConfig = null;
  logger.debug('Compact model configuration reset');
}

/**
 * Check if compact model is available
 */
export function isCompactModelAvailable(): boolean {
  const config = initializeCompactModel();
  return config !== null;
}

/**
 * Get compact model info for debugging
 */
export function getCompactModelInfo(): { provider: string; model: string } | null {
  const config = initializeCompactModel();
  if (!config) return null;
  return {
    provider: config.provider,
    model: config.model,
  };
}
