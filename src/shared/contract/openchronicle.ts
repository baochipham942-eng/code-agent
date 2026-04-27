// ============================================================================
// OpenChronicle (工作轨迹) — shared types
// ============================================================================

export interface OpenchronicleSettings {
  enabled: boolean;
  autoInjectContext: boolean;
  blacklistApps: string[];
  blacklistUrlPatterns: string[];
}

export const DEFAULT_OPENCHRONICLE_SETTINGS: OpenchronicleSettings = {
  enabled: false,
  autoInjectContext: true,
  blacklistApps: [
    '1Password',
    'Bitwarden',
    'Keychain Access',
    '微信',
    'WeChat',
  ],
  blacklistUrlPatterns: [
    '*.bank.com',
    'accounts.google.com/signin*',
    'mp.weixin.qq.com/wxauth*',
  ],
};

/** OpenChronicle daemon 的 MCP HTTP 端点（loopback only）。supervisor 健康探测和
 * contextProvider 拉 current_context 都用这个。 */
export const OPENCHRONICLE_MCP_ENDPOINT = 'http://127.0.0.1:8742/mcp';

export type OpenchronicleProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface OpenchronicleStatus {
  state: OpenchronicleProcessState;
  pid?: number;
  mcpEndpoint?: string;
  mcpHealthy: boolean;
  bufferFiles?: number;
  memoryEntries?: number;
  lastError?: string;
}
