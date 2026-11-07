// ============================================================================
// mcpReauthorize —— 聊天卡「重新授权」的宿主动作
// ============================================================================
// 作废 tokens（保留 client 注册）→ 重连触发与首次连接相同的授权流，并把 403 声明缺的
// scope 并进授权 URL（见 mcpScopeUpgrade）→ 等授权完成后按连接态回报。
// 授权被拒 / 超时：返回 success:false + 原因，卡片保留失败态让用户重试，不自动重试。
// ============================================================================

import { McpOAuthProvider } from './mcpOAuthProvider';
import { setMcpScopeUpgradeHint } from './mcpScopeUpgrade';
import { isHttpStreamableConfig } from './types';
import type { MCPClient } from './mcpClient';

export async function reauthorizeMcpServer(
  client: MCPClient,
  serverName: string,
  requiredScope?: string,
): Promise<{ success: boolean; error?: string }> {
  const state = client.getServerState(serverName);
  if (!state || !isHttpStreamableConfig(state.config) || state.config.auth !== 'oauth') {
    return { success: false, error: `MCP server "${serverName}" is not configured for OAuth` };
  }
  const serverIdentity = client.getServerIdentity(serverName);
  if (!serverIdentity) return { success: false, error: `MCP server "${serverName}" identity is unavailable` };

  new McpOAuthProvider({
    serverIdentity,
    serverName,
    redirectUrl: () => 'http://127.0.0.1/oauth-management',
    state: () => 'oauth-management',
    onRedirectToAuthorization: () => {
      throw new Error('OAuth management provider cannot start authorization');
    },
  }).invalidateCredentials('tokens');
  setMcpScopeUpgradeHint(serverIdentity, requiredScope);
  const reconnected = await client.reconnect(serverName);
  await client.waitForPendingOAuthAuthorization(serverName);
  if (client.isConnected(serverName)) return { success: true };
  setMcpScopeUpgradeHint(serverIdentity, undefined);
  return { success: false, error: reconnected.error ?? 'authorization was not completed' };
}
