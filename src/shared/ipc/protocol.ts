// ============================================================================
// IPC Protocol - 统一的 IPC 通信协议定义
// ============================================================================

// ----------------------------------------------------------------------------
// 请求/响应格式
// ----------------------------------------------------------------------------

/**
 * IPC 请求格式
 */
export interface IPCRequest<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string; // 用于追踪请求
}

/**
 * IPC 响应格式
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

// ----------------------------------------------------------------------------
// 领域通道定义
// ----------------------------------------------------------------------------

/**
 * Agent 通道 actions
 */
export type AgentAction = 'send' | 'cancel' | 'retry';

/**
 * Session 通道 actions
 */
export type SessionAction = 'list' | 'create' | 'load' | 'delete' | 'export' | 'import' | 'getMessages' | 'archive' | 'unarchive';

/**
 * Generation 通道 actions
 */
export type GenerationAction = 'list' | 'switch' | 'getPrompt' | 'getCurrent';

/**
 * Auth 通道 actions
 */
export type AuthAction = 'login' | 'logout' | 'getStatus' | 'getUser' | 'refresh' | 'generateQuickToken' | 'signInToken';

/**
 * Sync 通道 actions
 */
export type SyncAction = 'start' | 'stop' | 'getStatus' | 'forceFull';

/**
 * Cloud 通道 actions
 */
export type CloudAction = 'refreshConfig' | 'getInfo' | 'submitTask' | 'getTask' | 'listTasks';

/**
 * Workspace 通道 actions
 */
export type WorkspaceAction = 'selectDirectory' | 'getCurrent' | 'listFiles' | 'readFile';

/**
 * Settings 通道 actions
 */
export type SettingsAction = 'get' | 'set' | 'getDevMode' | 'setDevMode';

/**
 * Update 通道 actions
 */
export type UpdateAction = 'check' | 'getInfo' | 'openUrl' | 'startAutoCheck' | 'stopAutoCheck';

/**
 * MCP 通道 actions
 */
export type McpAction =
  | 'call'
  | 'listTools'
  | 'listResources'
  | 'readResource'
  | 'getStatus'
  | 'getServerStates'
  | 'setServerEnabled'
  | 'reconnectServer'
  | 'refreshFromCloud';

/**
 * Memory 通道 actions
 */
export type MemoryAction = 'store' | 'search' | 'getContext' | 'getStats';

/**
 * Planning 通道 actions
 */
export type PlanningAction = 'getPlan' | 'getFindings' | 'getErrors' | 'getState';

/**
 * Window 通道 actions
 */
export type WindowAction = 'minimize' | 'maximize' | 'close';

/**
 * Data 通道 actions
 */
export type DataAction = 'getStats' | 'clearToolCache' | 'cleanExpired';

/**
 * Device 通道 actions
 */
export type DeviceAction = 'list' | 'register' | 'remove';

// ----------------------------------------------------------------------------
// 通道映射
// ----------------------------------------------------------------------------

/**
 * 所有 IPC 通道及其 action 类型
 */
export interface IPCChannelActions {
  agent: AgentAction;
  session: SessionAction;
  generation: GenerationAction;
  auth: AuthAction;
  sync: SyncAction;
  cloud: CloudAction;
  workspace: WorkspaceAction;
  settings: SettingsAction;
  update: UpdateAction;
  mcp: McpAction;
  memory: MemoryAction;
  planning: PlanningAction;
  window: WindowAction;
  data: DataAction;
  device: DeviceAction;
}

/**
 * 通道名称类型
 */
export type IPCChannel = keyof IPCChannelActions;

/**
 * 新版通道名称常量
 */
export const IPC_DOMAINS = {
  AGENT: 'agent',
  SESSION: 'session',
  GENERATION: 'generation',
  AUTH: 'auth',
  SYNC: 'sync',
  CLOUD: 'cloud',
  WORKSPACE: 'workspace',
  SETTINGS: 'settings',
  UPDATE: 'update',
  MCP: 'mcp',
  MEMORY: 'memory',
  PLANNING: 'planning',
  WINDOW: 'window',
  DATA: 'data',
  DEVICE: 'device',
} as const;

// ----------------------------------------------------------------------------
// 类型工具
// ----------------------------------------------------------------------------

/**
 * 创建类型安全的 IPC 请求
 */
export function createIPCRequest<T>(
  action: string,
  payload?: T,
  requestId?: string
): IPCRequest<T> {
  return {
    action,
    payload,
    requestId: requestId || `req_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
  };
}

/**
 * 创建成功响应
 */
export function createSuccessResponse<T>(data: T): IPCResponse<T> {
  return {
    success: true,
    data,
  };
}

/**
 * 创建错误响应
 */
export function createErrorResponse(code: string, message: string, details?: unknown): IPCResponse<never> {
  return {
    success: false,
    error: {
      code,
      message,
      details,
    },
  };
}

// ----------------------------------------------------------------------------
// 错误代码
// ----------------------------------------------------------------------------

export const IPC_ERROR_CODES = {
  // 通用错误
  UNKNOWN: 'UNKNOWN',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // 业务错误
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  AGENT_BUSY: 'AGENT_BUSY',
  AGENT_NOT_RUNNING: 'AGENT_NOT_RUNNING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',
  MCP_NOT_CONNECTED: 'MCP_NOT_CONNECTED',

  // 系统错误
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
} as const;

export type IPCErrorCode = typeof IPC_ERROR_CODES[keyof typeof IPC_ERROR_CODES];
