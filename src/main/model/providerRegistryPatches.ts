// ============================================================================
// Provider Registry - dynamic catalog patches
// ============================================================================

import type { ModelInfo, ProviderConfig } from '../../shared/contract';
import { MODEL_API_ENDPOINTS } from '../../shared/constants';

export function applyProviderRegistryPatches(registry: Record<string, ProviderConfig>): void {
  function registerModel(providerId: string, model: ModelInfo): void {
    const provider = registry[providerId];
    if (!provider || provider.models.some((entry) => entry.id === model.id)) {
      return;
    }
    provider.models.push(model);
  }

  function textModel(
    id: string,
    name: string,
    capabilities: ModelInfo['capabilities'],
    maxTokens: number,
    costType: ModelInfo['costType'] = 'payg',
    supportsTool = true,
  ): ModelInfo {
    return {
      id,
      name,
      capabilities,
      maxTokens,
      supportsTool,
      supportsVision: false,
      supportsStreaming: true,
      costType,
    };
  }

  // Keep the runtime registry in sync with the central 2026 model constants.
  // The hand-written registry still carries capability metadata, so only the
  // missing current catalog IDs are patched in here.
  const openAIModelPatches: Array<{
    id: string;
    name: string;
    capabilities: ModelInfo['capabilities'];
    maxTokens: number;
  }> = [
    { id: 'gpt-5.5', name: 'GPT-5.5', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 128000 },
    { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 128000 },
    { id: 'gpt-5.4', name: 'GPT-5.4', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 128000 },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', capabilities: ['general', 'code', 'vision', 'fast'], maxTokens: 128000 },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', capabilities: ['general', 'fast'], maxTokens: 128000 },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', capabilities: ['code', 'reasoning'], maxTokens: 128000 },
    { id: 'gpt-5.2', name: 'GPT-5.2', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 128000 },
  ];

  openAIModelPatches.forEach(({ id, name, capabilities, maxTokens }) => {
    registerModel('openai', {
      ...textModel(id, name, capabilities, maxTokens),
      supportsVision: (capabilities as readonly string[]).includes('vision'),
      visionCapabilities: (capabilities as readonly string[]).includes('vision')
        ? { supportsBase64: true, supportsUrl: true, supportedFormats: ['png', 'jpeg', 'gif', 'webp'] }
        : undefined,
    });
  });

  const geminiModelPatches: Array<{
    id: string;
    name: string;
    capabilities: ModelInfo['capabilities'];
    maxTokens: number;
  }> = [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 64000 },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 64000 },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', capabilities: ['general', 'code', 'vision', 'fast'], maxTokens: 64000 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: ['general', 'code', 'vision', 'reasoning'], maxTokens: 64000 },
  ];

  geminiModelPatches.forEach(({ id, name, capabilities, maxTokens }) => {
    registerModel('gemini', {
      ...textModel(id, name, capabilities, maxTokens),
      supportsVision: true,
      visionCapabilities: { supportsBase64: true, supportsUrl: true, supportedFormats: ['png', 'jpeg', 'gif', 'webp'] },
    });
  });

  registerModel('zhipu', textModel('glm-5.1', 'GLM-5.1', ['general', 'code', 'reasoning'], 16384, 'yearly'));
  registerModel('zhipu', textModel('glm-4.7-flashx', 'GLM-4.7 FlashX', ['general', 'code', 'fast'], 8192, 'yearly'));

  registerModel('qwen', textModel('qwen3.6-plus', 'Qwen 3.6 Plus', ['general', 'code', 'longContext'], 32768));
  registerModel('qwen', textModel('qwen-plus-latest', 'Qwen Plus Latest', ['general', 'code', 'longContext'], 32768));
  registerModel('qwen', textModel('qwen3-coder', 'Qwen3 Coder', ['code', 'longContext'], 131072));

  registerModel('moonshot', textModel('kimi-k2.6', 'Kimi K2.6', ['general', 'code', 'reasoning', 'longContext'], 32768, 'monthly'));
  registerModel('moonshot', textModel('kimi-k2-turbo-preview', 'Kimi K2 Turbo Preview', ['general', 'code', 'fast', 'longContext'], 32768, 'monthly'));
  registerModel('moonshot', textModel('kimi-k2-thinking', 'Kimi K2 Thinking', ['general', 'code', 'reasoning', 'longContext'], 32768, 'monthly'));

  registerModel('minimax', textModel('MiniMax-M2.7', 'MiniMax M2.7', ['general', 'code', 'reasoning', 'longContext'], 131072));
  registerModel('minimax', textModel('MiniMax-M2.5', 'MiniMax M2.5', ['general', 'code', 'longContext'], 131072));

  registerModel('perplexity', textModel('sonar-reasoning-pro', 'Sonar Reasoning Pro', ['search', 'reasoning'], 8192, 'payg', false));
  registerModel('perplexity', textModel('sonar-reasoning', 'Sonar Reasoning', ['search', 'reasoning'], 8192, 'payg', false));
  registerModel('perplexity', textModel('sonar-deep-research', 'Sonar Deep Research', ['search', 'reasoning', 'longContext'], 8192, 'payg', false));

  registerModel('volcengine', {
    ...textModel('doubao-seed-1-6', 'Doubao Seed 1.6', ['general', 'code', 'vision', 'longContext'], 32768),
    supportsVision: true,
    visionCapabilities: { supportsBase64: true, supportsUrl: true, supportedFormats: ['png', 'jpeg', 'gif', 'webp'] },
  });
  registerModel('volcengine', textModel('doubao-seed-1-6-thinking', 'Doubao Seed 1.6 Thinking', ['reasoning', 'code', 'longContext'], 32768, 'payg', false));
  registerModel('volcengine', textModel('doubao-seed-1-6-flash', 'Doubao Seed 1.6 Flash', ['general', 'fast', 'longContext'], 32768));
  registerModel('volcengine', textModel('doubao-seed-1-6-lite', 'Doubao Seed 1.6 Lite', ['general', 'fast', 'longContext'], 32768));

  registry.grok = {
    id: 'grok',
    name: 'Grok',
    requiresApiKey: true,
    baseUrl: MODEL_API_ENDPOINTS.grok,
    models: [
      textModel('grok-4-1-fast-reasoning', 'Grok 4.1 Fast Reasoning', ['general', 'reasoning', 'longContext'], 32768),
      textModel('grok-4-1-fast-non-reasoning', 'Grok 4.1 Fast', ['general', 'fast', 'longContext'], 32768),
    ],
  };

}
