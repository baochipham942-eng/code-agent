// ============================================================================
// Auth and Token Inventory Contract
// ============================================================================

export type AuthInventoryItemId =
  | 'provider.api_key'
  | 'channel.token'
  | 'mcp.env'
  | 'mcp.header'
  | 'mcp.oauth'
  | 'browser.relay_token';

export interface AuthInventoryItem {
  id: AuthInventoryItemId;
  title: string;
  examples: string[];
  storage: string;
  display: string;
  revoke: string;
  diagnosticPolicy: string;
}

export const AUTH_INVENTORY: Record<AuthInventoryItemId, AuthInventoryItem> = {
  'provider.api_key': {
    id: 'provider.api_key',
    title: '模型 Provider API Key',
    examples: ['OpenAI', 'Anthropic', 'Groq', 'Moonshot', 'Zhipu'],
    storage: 'secure storage / Keychain / encrypted backup',
    display: '普通读取只显示 apiKeyConfigured；不展示完整 key。',
    revoke: '在模型设置删除 key，或去服务商控制台轮换。',
    diagnosticPolicy: '诊断包和日志必须脱敏 provider key。',
  },
  'channel.token': {
    id: 'channel.token',
    title: '通道 Token 和 App Secret',
    examples: ['HTTP API key', 'Feishu appSecret', 'Telegram botToken'],
    storage: '通道配置保存在 secure storage。',
    display: '表单默认 password/masked；复制完整值必须是显式动作。',
    revoke: '禁用/删除通道，或在外部平台撤销 token。',
    diagnosticPolicy: 'channel raw payload 和日志默认隐藏 token、secret、authorization、cookie。',
  },
  'mcp.env': {
    id: 'mcp.env',
    title: 'MCP 环境变量凭证',
    examples: ['TOKEN', 'API_KEY', 'PRIVATE_KEY'],
    storage: 'MCP server config，本地保存。',
    display: '疑似 secret 的 env value 默认只显示 configured/masked。',
    revoke: '编辑 MCP server config 或禁用 server。',
    diagnosticPolicy: 'MCP 调用日志递归隐藏 secret-like env。',
  },
  'mcp.header': {
    id: 'mcp.header',
    title: 'MCP Header 凭证',
    examples: ['Authorization', 'X-API-Key', 'Cookie'],
    storage: 'MCP server config，本地保存。',
    display: 'Header value 默认 masked；JSON 原文编辑需要提示风险。',
    revoke: '编辑 MCP server config 或服务端轮换 key。',
    diagnosticPolicy: '诊断和日志隐藏 Authorization、cookie、api key。',
  },
  'mcp.oauth': {
    id: 'mcp.oauth',
    title: 'MCP OAuth 授权',
    examples: ['access token', 'refresh token', 'client secret'],
    storage: 'OAuth token store / secure storage。',
    display: 'UI 只显示 connected、expired、reauthorize、revoke，不展示 token。',
    revoke: 'MCP 设置里 revoke/reauthorize，或服务商控制台撤回授权。',
    diagnosticPolicy: 'OAuth token 永不进入普通设置 payload、日志或诊断明文。',
  },
  'browser.relay_token': {
    id: 'browser.relay_token',
    title: '浏览器 Relay Token',
    examples: ['Chrome extension token', 'local relay token'],
    storage: '浏览器扩展本地存储和本机 relay 配置。',
    display: '只显示 token hint 和连接状态；完整 token 只在受控管理动作中出现。',
    revoke: '关闭 relay、移除扩展或重新生成 token。',
    diagnosticPolicy: 'relay token、cookie、authorization 在日志和诊断包里脱敏。',
  },
};

export const AUTH_INVENTORY_IDS = Object.keys(AUTH_INVENTORY) as AuthInventoryItemId[];

export function listAuthInventoryItems(): AuthInventoryItem[] {
  return AUTH_INVENTORY_IDS.map((id) => AUTH_INVENTORY[id]);
}
