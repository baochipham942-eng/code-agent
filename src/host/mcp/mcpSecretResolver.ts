import { getConfigService } from '../services/core/configService';
import type { MCPServerConfig } from './types';
import { isHttpStreamableConfig, isSSEConfig, isStdioConfig } from './types';
import { parseSecretRef, resolveSecretRefs, SECRET_REF_PREFIX } from './secretRef';

const URL_CREDENTIAL_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function containsSecretRef(values: Record<string, string> | undefined): boolean {
  return values
    ? Object.values(values).some((value) => (
      value.startsWith(SECRET_REF_PREFIX) && parseSecretRef(value) !== null
    ))
    : false;
}

function hasUrlCredentialPlaceholder(config: MCPServerConfig): boolean {
  return (isSSEConfig(config) || isHttpStreamableConfig(config))
    && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(config.serverUrl);
}

function resolveRemoteUrlCredentials(
  config: MCPServerConfig,
  headers: Record<string, string> | undefined,
): MCPServerConfig {
  if (!isSSEConfig(config) && !isHttpStreamableConfig(config)) return config;

  const consumedHeaderKeys = new Set<string>();
  const serverUrl = config.serverUrl.replace(URL_CREDENTIAL_PLACEHOLDER, (_placeholder, key: string) => {
    const value = headers?.[key];
    if (!value) {
      throw new Error(`MCP URL credential "${key}" is missing; please re-enter it in Connectors`);
    }
    consumedHeaderKeys.add(key);
    return encodeURIComponent(value);
  });
  const outgoingHeaders = headers
    ? Object.fromEntries(Object.entries(headers).filter(([key]) => !consumedHeaderKeys.has(key)))
    : undefined;

  return {
    ...config,
    serverUrl,
    headers: outgoingHeaders && Object.keys(outgoingHeaders).length > 0 ? outgoingHeaders : undefined,
  };
}

/**
 * 只为 transport 生成解引用后的配置；调用方必须保留原始引用版配置。
 */
export function resolveServerConfigSecrets(config: MCPServerConfig): MCPServerConfig {
  const values = isStdioConfig(config)
    ? config.env
    : (isSSEConfig(config) || isHttpStreamableConfig(config) ? config.headers : undefined);

  const needsSecretResolution = containsSecretRef(values);
  const needsUrlResolution = hasUrlCredentialPlaceholder(config);
  if (!needsSecretResolution && !needsUrlResolution) {
    return config;
  }

  const resolved = needsSecretResolution && values
    ? resolveSecretRefs(values, (integrationId) => (
        getConfigService()?.getIntegration(integrationId) ?? null
      ))
    : values;

  if (isStdioConfig(config)) {
    return { ...config, env: resolved };
  }
  if (isSSEConfig(config) || isHttpStreamableConfig(config)) {
    return resolveRemoteUrlCredentials(config, resolved);
  }
  return config;
}
