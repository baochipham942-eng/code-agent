// ============================================================================
// Compact Model Service - Provides AI summarization for context compression
// ============================================================================
// Uses the compact model (cheap, fast) for context compression tasks:
// - Conversation summarization
// - Token reduction
// - Information extraction
// ============================================================================

import { ContextLengthExceededError, ModelRouter } from '../model/modelRouter';
import { getConfigService } from '../services';
import type { ModelConfig, ModelProvider } from '../../shared/contract';
import type { AppSettings } from '../../shared/contract/settings';
import { createLogger } from '../services/infra/logger';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../shared/constants';

const logger = createLogger('CompactModel');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type CompactModelFallbackReason =
  | 'compact_model_unavailable'
  | 'compact_model_missing_api_key'
  | 'compact_context_length_exceeded';

export interface CompactModelSummaryMetadata {
  provider: ModelProvider;
  model: string;
  useMainModel: boolean;
  fallbackReason?: CompactModelFallbackReason;
}

export interface CompactModelSummaryResult {
  summary: string;
  metadata: CompactModelSummaryMetadata;
}

interface ResolvedSummaryModel {
  config: ModelConfig;
  useMainModel: boolean;
  fallbackReason?: CompactModelFallbackReason;
}

// ----------------------------------------------------------------------------
// Compact Model Service
// ----------------------------------------------------------------------------

let modelRouter: ModelRouter | null = null;
let compactModelResolution: ResolvedSummaryModel | null = null;

function shouldUseE2ELocalCompactModel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_E2E === '1' && env.CODE_AGENT_E2E_LOCAL_COMPACT_MODEL === '1';
}

function buildE2ELocalCompactSummary(prompt: string): string {
  const promptDigest = Buffer.from(prompt).toString('base64').slice(0, 24);
  return [
    'E2E local compact summary.',
    `Prompt digest: ${promptDigest}`,
    'Earlier conversation turns were compacted by the compact model boundary during app-host smoke.',
  ].join('\n');
}

function getProviderBaseUrl(settings: AppSettings, provider: ModelProvider): string | undefined {
  return settings.models?.providers?.[provider]?.baseUrl;
}

function getConfiguredCompactModel(settings: AppSettings): Pick<ModelConfig, 'provider' | 'model'> | null {
  const provider = settings.contextCompression?.compactProvider as ModelProvider | undefined;
  const model = settings.contextCompression?.compactModel;
  if (!provider || !model) return null;
  return { provider, model };
}

function getModelApiKey(
  configService: ReturnType<typeof getConfigService>,
  provider: ModelProvider,
  model: string
): string | undefined {
  if (provider === 'moonshot' && model === DEFAULT_MODELS.compact) {
    return process.env.KIMI_K25_API_KEY || configService.getApiKey(provider);
  }
  return configService.getApiKey(provider);
}

function isContextLengthError(error: unknown): boolean {
  if (error instanceof ContextLengthExceededError) return true;
  const maybeError = error as { code?: string; message?: string; name?: string } | undefined;
  if (maybeError?.code === 'CONTEXT_LENGTH_EXCEEDED' || maybeError?.name === 'ContextLengthExceededError') {
    return true;
  }
  return /context length|上下文长度超出|maximum context length/i.test(maybeError?.message ?? '');
}

async function requestSummary(
  router: ModelRouter,
  config: ModelConfig,
  finalPrompt: string,
  maxTokens: number,
  useMainModel: boolean
): Promise<string> {
  logger.debug('Generating summary', {
    provider: config.provider,
    model: config.model,
    promptLength: finalPrompt.length,
    maxTokens,
    useMainModel,
  });

  const response = await router.inference(
    [{ role: 'user', content: finalPrompt }],
    [],
    {
      ...config,
      maxTokens: Math.min(maxTokens, config.maxTokens || 2048),
    }
  );

  if (response.content) {
    logger.debug('Summary generated', {
      responseLength: response.content.length,
    });
    return response.content;
  }

  throw new Error('Empty response from compact model');
}

/**
 * Initialize the compact model configuration
 * Uses the 'compact' capability fallback model
 */
function initializeCompactModel(): ModelConfig | null {
  const resolution = initializeCompactSummaryModel();
  return resolution?.config ?? null;
}

function initializeCompactSummaryModel(): ResolvedSummaryModel | null {
  if (compactModelResolution) return compactModelResolution;

  try {
    const configService = getConfigService();
    const settings = configService.getSettings();

    // Get base config from user settings
    const provider = (settings.model?.provider || DEFAULT_PROVIDER) as ModelProvider;
    const baseConfig: ModelConfig = {
      provider,
      model: settings.model?.model || DEFAULT_MODELS.chat,
      apiKey: '', // Will be retrieved from secure storage
      baseUrl: getProviderBaseUrl(settings, provider),
      temperature: 0.3, // Lower temperature for consistent summaries
      maxTokens: 2048,
    };

    // Initialize router if needed
    if (!modelRouter) {
      modelRouter = new ModelRouter();
    }

    const configuredCompact = getConfiguredCompactModel(settings);
    if (configuredCompact) {
      const apiKey = getModelApiKey(configService, configuredCompact.provider, configuredCompact.model);
      if (apiKey) {
        compactModelResolution = {
          config: {
            provider: configuredCompact.provider,
            model: configuredCompact.model,
            apiKey,
            baseUrl: getProviderBaseUrl(settings, configuredCompact.provider),
            temperature: 0.3,
            maxTokens: 2048,
          },
          useMainModel: false,
        };
        logger.info('Configured compact model initialized', {
          provider: compactModelResolution.config.provider,
          model: compactModelResolution.config.model,
        });
        return compactModelResolution;
      }
      logger.warn('Configured compact model has no API key, using fallback model', {
        provider: configuredCompact.provider,
        model: configuredCompact.model,
      });
    }

    // Get the compact fallback model
    const fallbackConfig = modelRouter.getFallbackConfig('compact', baseConfig);

    if (fallbackConfig) {
      const fallbackProvider = fallbackConfig.provider as ModelProvider;
      const apiKey = fallbackConfig.apiKey || getModelApiKey(configService, fallbackProvider, fallbackConfig.model);
      if (apiKey) {
        compactModelResolution = {
          config: {
            ...fallbackConfig,
            apiKey,
            baseUrl: getProviderBaseUrl(settings, fallbackProvider),
            temperature: 0.3,
            maxTokens: 2048,
          },
          useMainModel: false,
        };
        logger.info('Compact model initialized', {
          provider: compactModelResolution.config.provider,
          model: compactModelResolution.config.model,
        });
        return compactModelResolution;
      }
      logger.warn('Compact fallback model has no API key, using main model for summarization', {
        provider: fallbackProvider,
        model: fallbackConfig.model,
      });
      const mainApiKey = getModelApiKey(configService, baseConfig.provider, baseConfig.model);
      if (mainApiKey) {
        compactModelResolution = {
          config: {
            ...baseConfig,
            apiKey: mainApiKey,
          },
          useMainModel: true,
          fallbackReason: 'compact_model_missing_api_key',
        };
        return compactModelResolution;
      }
    } else {
      logger.warn('Compact model not available, using main model for summarization');
      const mainApiKey = getModelApiKey(configService, baseConfig.provider, baseConfig.model);
      if (mainApiKey) {
        compactModelResolution = {
          config: {
            ...baseConfig,
            apiKey: mainApiKey,
          },
          useMainModel: true,
          fallbackReason: 'compact_model_unavailable',
        };
        return compactModelResolution;
      }
    }

    logger.error('No API key available for summarization');
    return null;
  } catch (error) {
    logger.error('Failed to initialize compact model', { error });
    return null;
  }
}

function resolveMainSummaryModel(): ResolvedSummaryModel | null {
  const config = initializeMainModel();
  if (!config) return null;
  return {
    config,
    useMainModel: true,
  };
}

function toSummaryResult(summary: string, resolution: ResolvedSummaryModel): CompactModelSummaryResult {
  return {
    summary,
    metadata: {
      provider: resolution.config.provider,
      model: resolution.config.model,
      useMainModel: resolution.useMainModel,
      fallbackReason: resolution.fallbackReason,
    },
  };
}

/**
 * Generate AI summary and return the actual model used.
 */
export async function compactModelSummarizeWithMetadata(
  prompt: string,
  maxTokens: number,
  options?: {
    /** 使用主模型做摘要（而非 cheap model），理解上下文更好 */
    useMainModel?: boolean;
    /** 自定义摘要指令，覆盖默认 prompt */
    instructions?: string;
  }
): Promise<CompactModelSummaryResult> {
  // 如果提供了自定义指令，替换 prompt 中的默认指令部分
  const finalPrompt = options?.instructions
    ? prompt.replace(/^.*?(?=\n\n对话历史：)/s, options.instructions)
    : prompt;

  if (shouldUseE2ELocalCompactModel()) {
    return {
      summary: buildE2ELocalCompactSummary(finalPrompt),
      metadata: {
        provider: 'acceptance',
        model: 'e2e-local-compact-model',
        useMainModel: false,
      },
    };
  }

  const resolution = options?.useMainModel
    ? resolveMainSummaryModel()
    : initializeCompactSummaryModel();

  if (!resolution) {
    throw new Error('Compact model not configured');
  }

  if (!modelRouter) {
    modelRouter = new ModelRouter();
  }

  try {
    const summary = await requestSummary(
      modelRouter,
      resolution.config,
      finalPrompt,
      maxTokens,
      resolution.useMainModel
    );
    return toSummaryResult(summary, resolution);
  } catch (error) {
    if (!options?.useMainModel && !resolution.useMainModel && isContextLengthError(error)) {
      const mainResolution = resolveMainSummaryModel();
      if (
        mainResolution
        && (mainResolution.config.provider !== resolution.config.provider || mainResolution.config.model !== resolution.config.model)
      ) {
        logger.warn('Compact model context window exceeded, retrying with main model', {
          compactProvider: resolution.config.provider,
          compactModel: resolution.config.model,
          mainProvider: mainResolution.config.provider,
          mainModel: mainResolution.config.model,
          promptLength: finalPrompt.length,
        });
        try {
          const summary = await requestSummary(modelRouter, mainResolution.config, finalPrompt, maxTokens, true);
          return toSummaryResult(summary, {
            ...mainResolution,
            fallbackReason: 'compact_context_length_exceeded',
          });
        } catch (fallbackError) {
          logger.error('Failed to generate summary with main model fallback', { error: fallbackError });
          throw fallbackError;
        }
      }
    }

    logger.error('Failed to generate summary', { error });
    throw error;
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
  const result = await compactModelSummarizeWithMetadata(prompt, maxTokens, options);
  return result.summary;
}

/**
 * Initialize main model for high-quality summarization
 */
function initializeMainModel(): ModelConfig | null {
  try {
    const configService = getConfigService();
    const settings = configService.getSettings();

    const provider = (settings.model?.provider || DEFAULT_PROVIDER) as ModelProvider;
    const model = settings.model?.model || DEFAULT_MODELS.chat;
    const apiKey = getModelApiKey(configService, provider, model);

    if (!apiKey) {
      logger.warn('No API key available for main model summarization');
      return null;
    }

    return {
      provider,
      model,
      apiKey,
      baseUrl: getProviderBaseUrl(settings, provider),
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
  compactModelResolution = null;
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
