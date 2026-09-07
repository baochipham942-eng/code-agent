// ============================================================================
// Lazy stdio server 搜索发现（MCPClient 拆出，N-SUBAGENT-ZEROTOOLS 返修被迫拆分）
// ============================================================================
// discoverLazyServersForSearch 的纯查询逻辑：ToolSearch 查询命中 lazy 服务器时
// 才按需拉起，避免为一次搜索连起所有 lazy server。从 mcpClient.ts 拆出是为
// max-lines 硬限（超 1000 必须拆）；MCPClient.discoverLazyServersForSearch 保留
// 为 thin delegate，外部调用方零影响。

import {
  isStdioConfig,
  CUA_DRIVER_SERVER_NAME,
  type MCPServerConfig,
  type MCPServerState,
} from './types';
import { CUA_SEARCH_KEYWORDS, extractMcpSearchKeywords } from './mcpSearchUtils';

/** discover 所需的 MCPClient 成员（private 字段由调用侧断言注入）。 */
export interface McpLazySearchClient {
  serverConfigs: Map<string, MCPServerConfig>;
  serverStates: Map<string, MCPServerState>;
  registry: { getToolCount(serverName: string): number };
  ensureConnected(serverName: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Discover lazy stdio servers that are likely relevant to a ToolSearch query.
 * This avoids starting every lazy server while making enabled servers like
 * sequential-thinking searchable before their first direct tool call.
 */
export async function discoverLazyMcpServersForSearch(
  client: McpLazySearchClient,
  query: string,
  serverNameAllowlist?: string[],
): Promise<Array<{
  serverName: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}>> {
  const keywords = extractMcpSearchKeywords(query);
  if (keywords.length === 0) return [];

  const candidates = Array.from(client.serverConfigs.values()).filter((config) => {
    if (!config.enabled) return false;
    // turn scope 收窄（serverNameAllowlist）时范围外的 lazy server 不拉起——拉起来结果也会被丢掉
    if (!isStdioConfig(config) || config.lazyLoad === false || (serverNameAllowlist !== undefined && !serverNameAllowlist.includes(config.name))) return false;

    const state = client.serverStates.get(config.name);
    if (!state || !['lazy', 'disconnected', 'error'].includes(state.status)) return false;

    const haystack = [
      config.name,
      config.command,
      ...(config.args || []),
    ].join(' ').toLowerCase();

    if (
      config.name === CUA_DRIVER_SERVER_NAME &&
      keywords.some((keyword) => CUA_SEARCH_KEYWORDS.has(keyword))
    ) {
      return true;
    }

    return keywords.some((keyword) => haystack.includes(keyword));
  });

  const results: Array<{
    serverName: string;
    connected: boolean;
    toolCount: number;
    error?: string;
  }> = [];

  for (const config of candidates) {
    const connected = await client.ensureConnected(config.name);
    const state = client.serverStates.get(config.name);
    results.push({
      serverName: config.name,
      connected,
      toolCount: client.registry.getToolCount(config.name),
      ...(state?.error ? { error: state.error } : {}),
    });
  }

  return results;
}
