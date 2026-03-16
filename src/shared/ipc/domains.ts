// ============================================================================
// IPC Domains - 领域通道定义 + 请求/响应协议
// ============================================================================

// ----------------------------------------------------------------------------
// New Domain-based IPC Channels (TASK-04)
// ----------------------------------------------------------------------------

/**
 * 新版领域通道 - 每个领域一个通道，通过 action 参数分发
 * 旧版通道保留用于向后兼容
 */
export const IPC_DOMAINS = {
  AGENT: 'domain:agent',
  SESSION: 'domain:session',
  AUTH: 'domain:auth',
  SYNC: 'domain:sync',
  CLOUD: 'domain:cloud',
  WORKSPACE: 'domain:workspace',
  SETTINGS: 'domain:settings',
  UPDATE: 'domain:update',
  MCP: 'domain:mcp',
  MEMORY: 'domain:memory',
  PLANNING: 'domain:planning',
  WINDOW: 'domain:window',
  DATA: 'domain:data',
  DEVICE: 'domain:device',
  TASK: 'domain:task', // Wave 5: 多任务并行
  DIFF: 'domain:diff', // E3: 变更追踪
  ERROR: 'domain:error',
  CRON: 'domain:cron',
  CAPTURE: 'domain:capture', // 浏览器采集
  DESKTOP: 'domain:desktop', // 原生桌面活动
  SOUL: 'domain:soul',
} as const;

export type IPCDomain = typeof IPC_DOMAINS[keyof typeof IPC_DOMAINS];

/**
 * 统一的 IPC 请求格式
 */
export interface IPCRequest<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string;
}

/**
 * 统一的 IPC 响应格式
 */
export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
