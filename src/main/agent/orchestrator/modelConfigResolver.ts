// ============================================================================
// Model Config Resolution - Provider/model selection logic
// ============================================================================

import type { ModelConfig, ModelProvider, PermissionRequest } from '../../../shared/contract';
import type { ConfigService } from '../../services/core/configService';
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  MODEL_MAX_TOKENS,
  getDefaultModelForProvider,
  getProviderInfo,
  normalizeProviderId,
} from '../../../shared/constants';
import { PROVIDER_REGISTRY } from '../../model/providerRegistry';
import { getAuthService } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ModelConfigResolver');

/**
 * 根据用户设置和认证状态解析完整的 ModelConfig
 */
export function resolveModelConfig(
  configService: ConfigService,
  settings: ReturnType<ConfigService['getSettings']>
): ModelConfig {
  const authService = getAuthService();
  const currentUser = authService.getCurrentUser();
  const isAdmin = currentUser?.isAdmin === true;

  // 从用户配置获取选择的 provider 和 model
  const userProviderStr = settings.models?.default || settings.models?.defaultProvider || DEFAULT_PROVIDER;
  const normalizedProvider = normalizeProviderId(userProviderStr) ?? DEFAULT_PROVIDER;
  const providerConfig =
    settings.models?.providers?.[normalizedProvider as keyof typeof settings.models.providers]
    ?? settings.models?.providers?.[userProviderStr as keyof typeof settings.models.providers];
  const userModel = providerConfig?.model || getDefaultModelByProvider(normalizedProvider);

  // 获取对应的 API Key
  const selectedApiKey = configService.getApiKey(normalizedProvider);

  let selectedProvider: ModelProvider = normalizedProvider;
  let selectedModel = userModel;

  logger.info(`[模型选择] 用户配置: provider=${selectedProvider}, model=${selectedModel}`);
  logger.debug(`Is admin: ${isAdmin}, hasApiKey: ${!!selectedApiKey}`);

  // 优先使用本地 API Key（无论是否管理员）
  if (selectedApiKey) {
    logger.info(`[模型选择] 使用本地 API Key: ${selectedProvider}`);
    return {
      provider: selectedProvider,
      model: selectedModel,
      apiKey: selectedApiKey,
      baseUrl: providerConfig?.baseUrl,
      temperature: 0.7,
      maxTokens: MODEL_MAX_TOKENS.DEFAULT,
    };
  }

  // 没有本地 Key，管理员走云端代理
  if (isAdmin) {
    const providerInfo = getProviderInfo(selectedProvider);
    if (!providerInfo?.cloudProxySupported) {
      const fallbackProvider = DEFAULT_PROVIDER as ModelProvider;
      logger.warn(
        `[模型选择] 云端代理不支持 ${selectedProvider}，回退到默认 provider ${fallbackProvider}`
      );
      selectedProvider = fallbackProvider;
      selectedModel = getDefaultModelByProvider(fallbackProvider);
    }
    logger.info(`[模型选择] 管理员使用云端代理: ${selectedProvider}`);
    return {
      provider: selectedProvider,
      model: selectedModel,
      apiKey: undefined,
      useCloudProxy: true,
      temperature: 0.7,
      maxTokens: MODEL_MAX_TOKENS.DEFAULT,
    };
  }

  // 非管理员且没有 Key
  logger.warn(`[模型选择] 未配置 ${selectedProvider} API Key`);
  return {
    provider: selectedProvider,
    model: selectedModel,
    apiKey: undefined,
    temperature: 0.7,
    maxTokens: MODEL_MAX_TOKENS.DEFAULT,
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
