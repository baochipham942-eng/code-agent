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
  ADMIN: 'domain:admin',
  SYNC: 'domain:sync',
  CLOUD: 'domain:cloud',
  WORKSPACE: 'domain:workspace',
  SETTINGS: 'domain:settings',
  UPDATE: 'domain:update',
  MCP: 'domain:mcp',
  CONNECTOR: 'domain:connector',
  MEMORY: 'domain:memory',
  PLANNING: 'domain:planning',
  WINDOW: 'domain:window',
  DATA: 'domain:data',
  DEVICE: 'domain:device',
  TASK: 'domain:task', // Wave 5: 多任务并行
  BACKGROUND_TASKS: 'domain:backgroundTasks',
  DIFF: 'domain:diff', // E3: 变更追踪
  ERROR: 'domain:error',
  CRON: 'domain:cron',
  CAPTURE: 'domain:capture', // 浏览器采集
  DESKTOP: 'domain:desktop', // 原生桌面活动
  ACTIVITY: 'domain:activity', // 屏幕记忆 / 桌面活动 provider 聚合
  SOUL: 'domain:soul',
  PROVIDER: 'domain:provider',
  LIVE_PREVIEW: 'domain:livePreview', // Live dev server 预览 + click-to-source bridge
  OPENCHRONICLE: 'domain:openchronicle', // 屏幕记忆（外部 OpenChronicle daemon 集成）
  PROMPT: 'domain:prompt', // 提示词管理（查看 + override）
  HOOK: 'domain:hook', // Hook 管理（列出已启用/未启用 + 打开配置）
  AGENT_REGISTRY: 'domain:agents', // 自定义 Agent 注册中心（builtin + user + project）
  ROLES: 'domain:roles', // 持久化角色资产（角色面板：列表/详情/记忆删改）
  PROJECT: 'domain:project', // P0-2 项目空间容器（项目/目标/角色入驻/产物聚合）
  AGENT_ENGINE: 'domain:agentEngine', // Native / Codex CLI / Claude Code execution engines
  CAPABILITY: 'domain:capability', // Skill / MCP / Tool / Channel 能力中心
  PII: 'domain:pii', // 本地 PII 防线（GLiNER 一键启用，B3 推荐组合）
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
