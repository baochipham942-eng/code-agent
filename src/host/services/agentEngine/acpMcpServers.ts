// ACP session/new 与 session/load 的 mcpServers 映射。
// stdio 在协议里没有 type 字段。
// 未信任目录的 project/local 文件由 loadMcpConfigFiles 整文件不读，这里不再二次判定。
// 同名按列表顺序后者整条覆盖（MCPClient.addServer）；本条被丢掉时先前同名版本一并清掉。

import type { McpCapabilities, McpServer } from '@agentclientprotocol/sdk';
import { SECRET_REF_PREFIX } from '../../mcp/secretRef';
import type { MCPServerConfig } from '../../mcp/types';
import {
  isHttpStreamableConfig,
  isSSEConfig,
  isStdioConfig,
} from '../../mcp/types';
import { createLogger } from '../infra/logger';

const logger = createLogger('AcpMcpServers');

export interface AcpMcpPassthrough {
  servers: McpServer[];
  dropped: Array<{
    name: string;
    reason: 'capability' | 'disabled' | 'unsupported' | 'secret';
    transport?: 'http' | 'sse';
  }>;
}

interface ToAcpMcpServersOptions {
  mcpCapabilities?: Pick<McpCapabilities, 'http' | 'sse'> | null;
  /** 与 Neo 启动 MCP 相同的解引用。缺省不调用存储器；留下的 secretRef 直接丢弃。 */
  resolveSecrets?: (config: MCPServerConfig) => MCPServerConfig;
}

function containsSecretRef(config: MCPServerConfig): boolean {
  const values: string[] = [];
  if (isStdioConfig(config)) {
    values.push(config.command, ...(config.args ?? []), ...Object.values(config.env ?? {}));
  }
  if (isSSEConfig(config) || isHttpStreamableConfig(config)) {
    values.push(config.serverUrl, ...Object.values(config.headers ?? {}));
  }
  return values.some((value) => value.startsWith(SECRET_REF_PREFIX));
}

function resolveConfig(
  config: MCPServerConfig,
  resolveSecrets: ToAcpMcpServersOptions['resolveSecrets'],
): MCPServerConfig | null {
  let resolved: MCPServerConfig;
  try {
    resolved = resolveSecrets ? resolveSecrets(config) : config;
  } catch (error) {
    // 只记名字。error.message 和配置值都可能带密钥。
    logger.warn('[ACP] MCP secret resolve threw', {
      serverName: config.name,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
  if (containsSecretRef(resolved)) {
    logger.warn('[ACP] MCP secret ref remains after resolve', {
      serverName: config.name,
    });
    return null;
  }
  return resolved;
}

function mapConfig(config: MCPServerConfig): McpServer | null {
  if (isStdioConfig(config)) {
    if (!config.command) return null;
    return {
      name: config.name,
      command: config.command,
      args: config.args ?? [],
      env: Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value })),
    };
  }
  if (isHttpStreamableConfig(config)) {
    return {
      type: 'http',
      name: config.name,
      url: config.serverUrl,
      headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value })),
    };
  }
  if (isSSEConfig(config)) {
    return {
      type: 'sse',
      name: config.name,
      url: config.serverUrl,
      headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value })),
    };
  }
  return null;
}

export function toAcpMcpServers(
  configs: readonly MCPServerConfig[],
  options: ToAcpMcpServersOptions = {},
): AcpMcpPassthrough {
  const dropped: AcpMcpPassthrough['dropped'] = [];
  const accepted = new Map<string, McpServer>();

  for (const config of configs) {
    // 先删再判：后来的同名条目无论因 disabled / capability / secret / unsupported 丢掉，都不留先前版本。
    accepted.delete(config.name);
    if (config.enabled === false) {
      dropped.push({ name: config.name, reason: 'disabled' });
      continue;
    }
    if (isHttpStreamableConfig(config) && options.mcpCapabilities?.http !== true) {
      dropped.push({ name: config.name, reason: 'capability', transport: 'http' });
      continue;
    }
    if (isSSEConfig(config) && options.mcpCapabilities?.sse !== true) {
      dropped.push({ name: config.name, reason: 'capability', transport: 'sse' });
      continue;
    }

    const resolved = resolveConfig(config, options.resolveSecrets);
    if (!resolved) {
      dropped.push({ name: config.name, reason: 'secret' });
      continue;
    }
    const server = mapConfig(resolved);
    if (!server) {
      dropped.push({ name: config.name, reason: 'unsupported' });
      continue;
    }
    accepted.set(config.name, server);
  }

  return { servers: [...accepted.values()], dropped };
}
