// ACP session/new 与 session/load 的 mcpServers 映射。
// stdio 在协议里没有 type 字段。folderTrust 的结论由调用方用 isProjectConfigTrusted 传入。

import type { McpCapabilities, McpServer } from '@agentclientprotocol/sdk';
import { SECRET_REF_PREFIX } from '../../mcp/secretRef';
import type { MCPServerConfig } from '../../mcp/types';
import {
  isHttpStreamableConfig,
  isSSEConfig,
  isStdioConfig,
} from '../../mcp/types';

export interface AcpMcpPassthrough {
  servers: McpServer[];
  dropped: Array<{
    name: string;
    reason: 'folder_trust' | 'capability' | 'disabled' | 'unsupported' | 'secret';
    transport?: 'http' | 'sse';
  }>;
}

interface ToAcpMcpServersOptions {
  mcpCapabilities?: Pick<McpCapabilities, 'http' | 'sse'> | null;
  /** isProjectConfigTrusted(cwd, 'project-mcp')。非 true 时丢掉 project scope 的 stdio。 */
  projectStdioTrusted?: boolean;
  /** isProjectConfigTrusted(cwd, 'project-mcp-local')。非 true 时丢掉 local scope 的 stdio。 */
  localStdioTrusted?: boolean;
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
  try {
    const resolved = resolveSecrets ? resolveSecrets(config) : config;
    return containsSecretRef(resolved) ? null : resolved;
  } catch {
    return null;
  }
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
    if (config.enabled === false) {
      dropped.push({ name: config.name, reason: 'disabled' });
      continue;
    }
    if (isStdioConfig(config) && config.scope === 'project' && options.projectStdioTrusted !== true) {
      dropped.push({ name: config.name, reason: 'folder_trust' });
      continue;
    }
    if (isStdioConfig(config) && config.scope === 'local' && options.localStdioTrusted !== true) {
      dropped.push({ name: config.name, reason: 'folder_trust' });
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
