// ============================================================================
// Model Config Resolution - Provider/model selection logic
// ============================================================================

import type { ModelConfig, ModelProvider, PermissionRequest } from '../../../shared/contract';
import type { ConfigService } from '../../services/core/configService';
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  getDefaultModelForProvider,
  getModelMaxOutputTokens,
  normalizeProviderId,
} from '../../../shared/constants';
import { PROVIDER_REGISTRY } from '../../model/providerRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ModelConfigResolver');

/**
 * 根据用户设置解析完整的 ModelConfig
 */
export function resolveModelConfig(
  configService: ConfigService,
  settings: ReturnType<ConfigService['getSettings']>
): ModelConfig {
  // 从用户配置获取选择的 provider 和 model
  const userProviderStr = settings.models?.defaultProvider || settings.models?.default || DEFAULT_PROVIDER;
  const normalizedProvider = (normalizeProviderId(userProviderStr) ?? userProviderStr ?? DEFAULT_PROVIDER) as ModelProvider;
  const providerConfig =
    settings.models?.providers?.[normalizedProvider]
    ?? settings.models?.providers?.[userProviderStr];
  const userModel = providerConfig?.model || getDefaultModelByProvider(normalizedProvider);
  const maxTokens = providerConfig?.maxTokens ?? getModelMaxOutputTokens(userModel);

  // 获取对应的 API Key
  const selectedApiKey = configService.getApiKey(normalizedProvider);

  const selectedProvider: ModelProvider = normalizedProvider;
  const selectedModel = userModel;

  logger.info(`[模型选择] 用户配置: provider=${selectedProvider}, model=${selectedModel}, hasApiKey=${!!selectedApiKey}`);

  if (!selectedApiKey) {
    logger.warn(`[模型选择] 未配置 ${selectedProvider} API Key，请在设置中配置本地 API Key`);
  }

  return {
    provider: selectedProvider,
    model: selectedModel,
    apiKey: selectedApiKey,
    baseUrl: providerConfig?.baseUrl,
    protocol: providerConfig?.protocol,
    temperature: 0.7,
    maxTokens,
  };
}

/**
 * 获取 provider 的默认模型
 */
export function getDefaultModelByProvider(provider: string): string {
  const normalizedProvider = normalizeProviderId(provider) ?? provider;
  const sharedDefaultModel = getDefaultModelForProvider(normalizedProvider);
  if (sharedDefaultModel) {
    return sharedDefaultModel;
  }

  // 从 PROVIDER_REGISTRY 获取每个 provider 的第一个模型作为默认
  const reg = PROVIDER_REGISTRY[normalizedProvider];
  if (reg && reg.models.length > 0) {
    return reg.models[0].id;
  }
  return DEFAULT_MODELS.chat;
}

/**
 * 将权限请求类型映射为权限级别
 */
export function getPermissionLevel(type: PermissionRequest['type']): 'read' | 'write' | 'execute' | 'network' {
  switch (type) {
    case 'file_read':
      return 'read';
    case 'file_write':
    case 'file_edit':
      return 'write';
    case 'command':
    case 'dangerous_command':
      return 'execute';
    case 'network':
      return 'network';
    default:
      return 'read';
  }
}
