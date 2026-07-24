import { getConfigService } from '../services/core/configService';
import type { MCPServerConfig } from './types';
import { isHttpStreamableConfig, isSSEConfig, isStdioConfig } from './types';
import { parseSecretRef, resolveSecretRefs, SECRET_REF_PREFIX } from './secretRef';

function containsSecretRef(values: Record<string, string> | undefined): boolean {
  return values
    ? Object.values(values).some((value) => (
      value.startsWith(SECRET_REF_PREFIX) && parseSecretRef(value) !== null
    ))
    : false;
}

/**
 * 只为 transport 生成解引用后的配置；调用方必须保留原始引用版配置。
 */
export function resolveServerConfigSecrets(config: MCPServerConfig): MCPServerConfig {
  const values = isStdioConfig(config)
    ? config.env
    : (isSSEConfig(config) || isHttpStreamableConfig(config) ? config.headers : undefined);

  if (!values || !containsSecretRef(values)) {
    return config;
  }

  const configService = getConfigService();
  const resolved = resolveSecretRefs(values, (integrationId) => (
    configService?.getIntegration(integrationId) ?? null
  ));

  if (isStdioConfig(config)) {
    return { ...config, env: resolved };
  }
  if (isSSEConfig(config) || isHttpStreamableConfig(config)) {
    return { ...config, headers: resolved };
  }
  return config;
}
