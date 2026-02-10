// ============================================================================
// IPC Channel Definitions
// Type-safe communication between main and renderer processes
// ============================================================================

import type {
  Generation,
  GenerationId,
  GenerationDiff,
  Message,
  MessageAttachment,
  PermissionResponse,
  Session,
  FileInfo,
  AppSettings,
  AgentEvent,
  TodoItem,
  TaskPlan,
  Finding,
  ErrorRecord,
  PlanningState,
  UserQuestionRequest,
  UserQuestionResponse,
  AuthUser,
  AuthStatus,
  SyncStatus,
  DeviceInfo,
  UpdateInfo,
  DownloadProgress,
} from './types';

// 带附件的消息请求
export interface AgentMessageRequest {
  content: string;
  attachments?: MessageAttachment[];
}

import type {
  CloudTask,
  CreateCloudTaskRequest,
  CloudTaskFilter,
  TaskProgressEvent,
  TaskSyncState,
  CloudExecutionStats,
} from './types/cloud';

import type {
  MemoryItem,
  MemoryCategory,
  MemoryStats as MemoryStatsNew,
  MemoryExport,
  MemoryLearnedEvent,
  MemoryConfirmRequest,
} from './types/memory';

import type {
  ContextHealthState,
  ContextHealthUpdateEvent,
} from './types/contextHealth';

import type { DAGVisualizationEvent } from './types/dagVisualization';
import { DAG_CHANNELS, LAB_CHANNELS, CHANNEL_CHANNELS, EVALUATION_CHANNELS, LSP_CHANNELS, BACKGROUND_CHANNELS, TELEMETRY_CHANNELS } from './ipc/channels';

import type {
  TelemetrySession,
  TelemetryTurn,
  TelemetryModelCall,
  TelemetryToolCall,
  TelemetryTimelineEvent,
  TelemetrySessionListItem,
  TelemetryToolStat,
  TelemetryIntentStat,
  TelemetryPushEvent,
} from './types/telemetry';

import type {
  ObjectiveMetrics,
  SubjectiveAssessment,
} from './types/sessionAnalytics';

// 会话分析结果（客观指标 + 历史评测 + SSE事件摘要）
export interface SessionAnalysisResult {
  sessionInfo: {
    title: string;
    modelProvider: string;
    modelName: string;
    startTime: number;
    endTime?: number;
    generationId: string;
    workingDirectory: string;
    status: string;
    turnCount: number;
    totalTokens: number;
    estimatedCost: number;
  } | null;
  objective: ObjectiveMetrics;
  previousEvaluations: {
    id: string;
    timestamp: number;
    overallScore: number;
    grade: string;
  }[];
  latestEvaluation: {
    id: string;
    sessionId: string;
    timestamp: number;
    objective: ObjectiveMetrics;
    subjective: SubjectiveAssessment | null;
  } | null;
  eventSummary: {
    eventStats: Record<string, number>;
    toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
    thinkingContent: string[];
    errorEvents: Array<{ type: string; message: string }>;
    timeline: Array<{ time: number; type: string; summary: string }>;
  } | null;
}

import type {
  ChannelAccount,
  ChannelType,
  ChannelAccountConfig,
  AddChannelAccountRequest,
  UpdateChannelAccountRequest,
} from './types/channel';

import type {
  LabProjectType,
  LabProjectStatus,
  PythonEnvStatus,
  TrainingProgressEvent,
  DownloadProjectRequest,
  DownloadProjectResponse,
  UploadDataRequest,
  UploadDataResponse,
  StartTrainingRequest,
  StartTrainingResponse,
  InferenceRequest,
  InferenceResult,
} from './types/lab';

import type {
  MarketplaceInfo,
  MarketplacePluginEntry,
  InstalledPlugin,
  MarketplaceResult,
  PluginInstallResult,
} from '../main/skills/marketplace/types';

import type {
  EvaluationResult,
  EvaluationExportFormat,
} from './types/evaluation';

// Re-export context health types for consumer convenience
export type { ContextHealthState, ContextHealthUpdateEvent } from './types/contextHealth';

import type {
  SessionStatus,
  SessionStatusUpdateEvent,
  SessionRuntimeSummary,
  BackgroundTaskInfo,
  BackgroundTaskUpdateEvent,
} from './types/sessionState';

import type { SwarmEvent } from './types/swarm';

// Re-export session state types for consumer convenience
export type {
  SessionStatus,
  SubagentState,
  SessionRuntimeSummary,
  SessionStatusUpdateEvent,
} from './types/sessionState';

// ----------------------------------------------------------------------------
// TaskList IPC Types
// ----------------------------------------------------------------------------

export type TaskItemStatusIpc = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TaskItemIpc {
  id: string;
  subject: string;
  description: string;
  status: TaskItemStatusIpc;
  assignee?: string;
  priority: number;
  dependencies: string[];
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
}

export interface TaskListStateIpc {
  tasks: TaskItemIpc[];
  autoAssign: boolean;
  requireApproval: boolean;
}

export interface TaskListEventIpc {
  type: string;
  task?: TaskItemIpc;
  taskId?: string;
  changes?: Partial<TaskItemIpc>;
  assignee?: string;
  reason?: string;
  result?: string;
  error?: string;
  state?: TaskListStateIpc;
}

// ----------------------------------------------------------------------------
// Additional Types for IPC
// ----------------------------------------------------------------------------

export interface SessionExport {
  id: string;
  title: string;
  generationId: GenerationId;
  modelConfig: any;
  workingDirectory?: string;
  messages: Message[];
  todos: TodoItem[];
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: {
    source: 'file' | 'conversation' | 'knowledge';
    path?: string;
    sessionId?: string;
    category?: string;
    timestamp?: number;
  };
}

export interface MemoryContextResult {
  ragContext: string;
  projectKnowledge: Array<{ key: string; value: any }>;
  relevantCode: SearchResult[];
  relevantConversations: SearchResult[];
}

export interface MemoryStats {
  sessionCount: number;
  messageCount: number;
  toolCacheSize: number;
  vectorStoreSize: number;
  projectKnowledgeCount: number;
}

/**
 * Memory Record - Gen5 记忆可视化
 */
export interface MemoryRecord {
  id: string;
  type: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
  category: string;
  content: string;
  summary: string;
  source: 'auto_learned' | 'user_defined' | 'session_extracted';
  projectPath: string | null;
  sessionId: string | null;
  confidence: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface MemoryListFilter {
  type?: MemoryRecord['type'];
  category?: string;
  source?: MemoryRecord['source'];
  currentProjectOnly?: boolean;
  currentSessionOnly?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at' | 'access_count' | 'confidence';
  orderDir?: 'ASC' | 'DESC';
}

export interface MemorySearchOptions {
  type?: MemoryRecord['type'];
  category?: string;
  limit?: number;
}

export interface MemoryStatsResult {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface MCPStatus {
  connectedServers: string[];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
}

export interface DataStats {
  sessionCount: number;
  messageCount: number;
  toolExecutionCount: number;
  knowledgeCount: number;
  databaseSize: number; // bytes
  cacheEntries: number;
}

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
  GENERATION: 'domain:generation',
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

// ----------------------------------------------------------------------------
// Legacy IPC Channel Names (Deprecated - use IPC_DOMAINS instead)
// ----------------------------------------------------------------------------

/** @deprecated Use IPC_DOMAINS instead */
export const IPC_CHANNELS = {
  // Agent channels
  AGENT_SEND_MESSAGE: 'agent:send-message',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_EVENT: 'agent:event',
  AGENT_PERMISSION_RESPONSE: 'agent:permission-response',

  // Generation channels
  GENERATION_LIST: 'generation:list',
  GENERATION_SWITCH: 'generation:switch',
  GENERATION_GET_PROMPT: 'generation:get-prompt',
  GENERATION_COMPARE: 'generation:compare',
  GENERATION_GET_CURRENT: 'generation:get-current',

  // Session channels
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_LOAD: 'session:load',
  SESSION_DELETE: 'session:delete',
  SESSION_GET_MESSAGES: 'session:get-messages',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_UPDATED: 'session:updated',
  SESSION_LIST_UPDATED: 'session:list-updated',
  SESSION_ARCHIVE: 'session:archive',
  SESSION_UNARCHIVE: 'session:unarchive',

  // Memory channels
  MEMORY: 'memory:manage',
  MEMORY_GET_CONTEXT: 'memory:get-context',
  MEMORY_SEARCH_CODE: 'memory:search-code',
  MEMORY_SEARCH_CONVERSATIONS: 'memory:search-conversations',
  MEMORY_GET_STATS: 'memory:get-stats',

  // MCP channels
  MCP_GET_STATUS: 'mcp:get-status',
  MCP_LIST_TOOLS: 'mcp:list-tools',
  MCP_LIST_RESOURCES: 'mcp:list-resources',
  MCP_EVENT: 'mcp:event',

  // Workspace channels
  WORKSPACE_SELECT_DIRECTORY: 'workspace:select-directory',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
  WORKSPACE_READ_FILE: 'workspace:read-file',
  WORKSPACE_GET_CURRENT: 'workspace:get-current',

  // Shell channels
  SHELL_OPEN_PATH: 'shell:open-path',

  // Settings channels
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_TEST_API_KEY: 'settings:test-api-key',
  SETTINGS_GET_SERVICE_KEYS: 'settings:get-service-keys',
  SETTINGS_SET_SERVICE_KEY: 'settings:set-service-key',
  SETTINGS_GET_INTEGRATION: 'settings:get-integration',
  SETTINGS_SET_INTEGRATION: 'settings:set-integration',

  // Window channels
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // App channels
  APP_GET_VERSION: 'app:get-version',

  // Planning channels (Gen 3+ persistent planning)
  PLANNING_GET_STATE: 'planning:get-state',
  PLANNING_GET_PLAN: 'planning:get-plan',
  PLANNING_GET_FINDINGS: 'planning:get-findings',
  PLANNING_GET_ERRORS: 'planning:get-errors',
  PLANNING_EVENT: 'planning:event',

  // User question channels (Gen 3+ ask_user_question)
  USER_QUESTION_ASK: 'user-question:ask',
  USER_QUESTION_RESPONSE: 'user-question:response',

  // Confirm action channels (Gen 3+ confirm_action)
  CONFIRM_ACTION_ASK: 'confirm-action:ask',
  CONFIRM_ACTION_RESPONSE: 'confirm-action:response',

  // Auth channels
  AUTH_GET_STATUS: 'auth:get-status',
  AUTH_SIGN_IN_EMAIL: 'auth:sign-in-email',
  AUTH_SIGN_UP_EMAIL: 'auth:sign-up-email',
  AUTH_SIGN_IN_OAUTH: 'auth:sign-in-oauth',
  AUTH_SIGN_IN_TOKEN: 'auth:sign-in-token',
  AUTH_SIGN_OUT: 'auth:sign-out',
  AUTH_GET_USER: 'auth:get-user',
  AUTH_UPDATE_PROFILE: 'auth:update-profile',
  AUTH_GENERATE_QUICK_TOKEN: 'auth:generate-quick-token',
  AUTH_RESET_PASSWORD: 'auth:reset-password',
  AUTH_UPDATE_PASSWORD: 'auth:update-password',
  AUTH_EVENT: 'auth:event',
  AUTH_PASSWORD_RESET_CALLBACK: 'auth:password-reset-callback',

  // Sync channels
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_START: 'sync:start',
  SYNC_STOP: 'sync:stop',
  SYNC_FORCE_FULL: 'sync:force-full',
  SYNC_RESOLVE_CONFLICT: 'sync:resolve-conflict',
  SYNC_EVENT: 'sync:event',

  // Device channels
  DEVICE_REGISTER: 'device:register',
  DEVICE_LIST: 'device:list',
  DEVICE_REMOVE: 'device:remove',

  // Update channels
  UPDATE_CHECK: 'update:check',
  UPDATE_GET_INFO: 'update:get-info',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_OPEN_FILE: 'update:open-file',
  UPDATE_OPEN_URL: 'update:open-url',
  UPDATE_START_AUTO_CHECK: 'update:start-auto-check',
  UPDATE_STOP_AUTO_CHECK: 'update:stop-auto-check',
  UPDATE_EVENT: 'update:event',

  // Cache channels
  CACHE_GET_STATS: 'cache:get-stats',
  CACHE_CLEAR: 'cache:clear',
  CACHE_CLEAN_EXPIRED: 'cache:clean-expired',

  // Data management channels
  DATA_GET_STATS: 'data:get-stats',
  DATA_CLEAR_TOOL_CACHE: 'data:clear-tool-cache',

  // Persistent settings (stored in secure storage, not affected by data clear)
  PERSISTENT_GET_DEV_MODE: 'persistent:get-dev-mode',
  PERSISTENT_SET_DEV_MODE: 'persistent:set-dev-mode',

  // Permission mode channels
  PERMISSION_GET_MODE: 'permission:get-mode',
  PERMISSION_SET_MODE: 'permission:set-mode',

  // Notification channels
  NOTIFICATION_CLICKED: 'notification:clicked',

  // Security channels (API Key setup, tool create confirm)
  SECURITY_CHECK_API_KEY_CONFIGURED: 'security:check-api-key-configured',
  SECURITY_TOOL_CREATE_REQUEST: 'security:tool-create-request',
  SECURITY_TOOL_CREATE_RESPONSE: 'security:tool-create-response',

  // Cloud config channels
  CLOUD_CONFIG_REFRESH: 'cloud:config:refresh',
  CLOUD_CONFIG_GET_INFO: 'cloud:config:get-info',

  // Skill Marketplace channels
  MARKETPLACE_LIST: 'marketplace:list',
  MARKETPLACE_ADD: 'marketplace:add',
  MARKETPLACE_REMOVE: 'marketplace:remove',
  MARKETPLACE_REFRESH: 'marketplace:refresh',
  MARKETPLACE_INFO: 'marketplace:info',
  MARKETPLACE_LIST_PLUGINS: 'marketplace:list-plugins',
  MARKETPLACE_SEARCH_PLUGINS: 'marketplace:search-plugins',
  MARKETPLACE_INSTALL_PLUGIN: 'marketplace:install-plugin',
  MARKETPLACE_UNINSTALL_PLUGIN: 'marketplace:uninstall-plugin',
  MARKETPLACE_LIST_INSTALLED: 'marketplace:list-installed',
  MARKETPLACE_ENABLE_PLUGIN: 'marketplace:enable-plugin',
  MARKETPLACE_DISABLE_PLUGIN: 'marketplace:disable-plugin',

  // Memory Phase 2/3 channels
  MEMORY_LEARNED: 'memory:learned',
  MEMORY_CONFIRM_REQUEST: 'memory:confirm-request',
  MEMORY_CONFIRM_RESPONSE: 'memory:confirm-response',

  // Context health channels
  CONTEXT_HEALTH_GET: 'context:health:get',
  CONTEXT_HEALTH_EVENT: 'context:health:event',

  // Session status channels (multi-session parallel support)
  SESSION_STATUS_UPDATE: 'session:status:update',
  SESSION_STATUS_GET: 'session:status:get',
  SESSION_STATUS_GET_ALL: 'session:status:get-all',

  // Cloud task channels
  CLOUD_TASK_CREATE: 'cloud:task:create',
  CLOUD_TASK_UPDATE: 'cloud:task:update',
  CLOUD_TASK_CANCEL: 'cloud:task:cancel',
  CLOUD_TASK_GET: 'cloud:task:get',
  CLOUD_TASK_LIST: 'cloud:task:list',
  CLOUD_TASK_DELETE: 'cloud:task:delete',
  CLOUD_TASK_START: 'cloud:task:start',
  CLOUD_TASK_PAUSE: 'cloud:task:pause',
  CLOUD_TASK_RESUME: 'cloud:task:resume',
  CLOUD_TASK_RETRY: 'cloud:task:retry',
  CLOUD_TASK_SYNC: 'cloud:task:sync',
  CLOUD_TASK_SYNC_STATE: 'cloud:task:syncState',
  CLOUD_TASK_PROGRESS: 'cloud:task:progress',
  CLOUD_TASK_COMPLETED: 'cloud:task:completed',
  CLOUD_TASK_FAILED: 'cloud:task:failed',
  CLOUD_TASK_STATS: 'cloud:task:stats',

  // Lab channels (实验室)
  LAB_DOWNLOAD_PROJECT: LAB_CHANNELS.DOWNLOAD_PROJECT,
  LAB_UPLOAD_DATA: LAB_CHANNELS.UPLOAD_DATA,
  LAB_START_TRAINING: LAB_CHANNELS.START_TRAINING,
  LAB_STOP_TRAINING: LAB_CHANNELS.STOP_TRAINING,
  LAB_INFERENCE: LAB_CHANNELS.INFERENCE,
  LAB_TRAINING_PROGRESS: LAB_CHANNELS.TRAINING_PROGRESS,
  LAB_GET_PROJECT_STATUS: LAB_CHANNELS.GET_PROJECT_STATUS,
  LAB_CHECK_PYTHON_ENV: LAB_CHANNELS.CHECK_PYTHON_ENV,

  // Channel channels (多通道接入)
  CHANNEL_LIST_ACCOUNTS: CHANNEL_CHANNELS.LIST_ACCOUNTS,
  CHANNEL_ADD_ACCOUNT: CHANNEL_CHANNELS.ADD_ACCOUNT,
  CHANNEL_UPDATE_ACCOUNT: CHANNEL_CHANNELS.UPDATE_ACCOUNT,
  CHANNEL_DELETE_ACCOUNT: CHANNEL_CHANNELS.DELETE_ACCOUNT,
  CHANNEL_CONNECT_ACCOUNT: CHANNEL_CHANNELS.CONNECT_ACCOUNT,
  CHANNEL_DISCONNECT_ACCOUNT: CHANNEL_CHANNELS.DISCONNECT_ACCOUNT,
  CHANNEL_GET_TYPES: CHANNEL_CHANNELS.GET_CHANNEL_TYPES,
  CHANNEL_ACCOUNT_STATUS_CHANGED: CHANNEL_CHANNELS.ACCOUNT_STATUS_CHANGED,
  CHANNEL_ACCOUNTS_CHANGED: CHANNEL_CHANNELS.ACCOUNTS_CHANGED,

  // Agent Routing channels
  AGENT_ROUTING_LIST: 'agent-routing:list',
  AGENT_ROUTING_UPSERT: 'agent-routing:upsert',
  AGENT_ROUTING_DELETE: 'agent-routing:delete',
  AGENT_ROUTING_SET_ENABLED: 'agent-routing:set-enabled',
  AGENT_ROUTING_SET_DEFAULT: 'agent-routing:set-default',

  // Evaluation channels (会话评测)
  EVALUATION_RUN: EVALUATION_CHANNELS.RUN,
  EVALUATION_GET_RESULT: EVALUATION_CHANNELS.GET_RESULT,
  EVALUATION_LIST_HISTORY: EVALUATION_CHANNELS.LIST_HISTORY,
  EVALUATION_EXPORT: EVALUATION_CHANNELS.EXPORT,
  EVALUATION_DELETE: EVALUATION_CHANNELS.DELETE,
  // Session Analytics (v2)
  EVALUATION_GET_OBJECTIVE_METRICS: EVALUATION_CHANNELS.GET_OBJECTIVE_METRICS,
  EVALUATION_GET_SESSION_ANALYSIS: EVALUATION_CHANNELS.GET_SESSION_ANALYSIS,
  EVALUATION_RUN_SUBJECTIVE: EVALUATION_CHANNELS.RUN_SUBJECTIVE_EVALUATION,

  // LSP channels (语言服务器)
  LSP_GET_STATUS: LSP_CHANNELS.GET_STATUS,
  LSP_CHECK_SERVERS: LSP_CHANNELS.CHECK_SERVERS,
  LSP_INITIALIZE: LSP_CHANNELS.INITIALIZE,

  // Background channels (后台任务)
  BACKGROUND_MOVE_TO_BACKGROUND: BACKGROUND_CHANNELS.MOVE_TO_BACKGROUND,
  BACKGROUND_MOVE_TO_FOREGROUND: BACKGROUND_CHANNELS.MOVE_TO_FOREGROUND,
  BACKGROUND_GET_TASKS: BACKGROUND_CHANNELS.GET_TASKS,
  BACKGROUND_GET_COUNT: BACKGROUND_CHANNELS.GET_COUNT,
  BACKGROUND_TASK_UPDATE: BACKGROUND_CHANNELS.TASK_UPDATE,

  // Swarm channels (Agent Swarm 监控)
  SWARM_EVENT: 'swarm:event',
  SWARM_SEND_USER_MESSAGE: 'swarm:send-user-message',
  SWARM_GET_AGENT_MESSAGES: 'swarm:get-agent-messages',
  SWARM_SET_DELEGATE_MODE: 'swarm:set-delegate-mode',

  // TaskList channels (任务列表可视化)
  TASKLIST_EVENT: 'taskList:event',
  TASKLIST_GET_STATE: 'taskList:getState',
  TASKLIST_GET_TASKS: 'taskList:getTasks',
  TASKLIST_UPDATE_TASK: 'taskList:updateTask',
  TASKLIST_REASSIGN: 'taskList:reassign',
  TASKLIST_APPROVE: 'taskList:approve',
  TASKLIST_APPROVE_ALL: 'taskList:approveAll',
  TASKLIST_DELETE_TASK: 'taskList:deleteTask',
  TASKLIST_SET_AUTO_ASSIGN: 'taskList:setAutoAssign',
  TASKLIST_SET_REQUIRE_APPROVAL: 'taskList:setRequireApproval',

  // Telemetry channels (遥测系统)
  TELEMETRY_GET_SESSION: TELEMETRY_CHANNELS.GET_SESSION,
  TELEMETRY_LIST_SESSIONS: TELEMETRY_CHANNELS.LIST_SESSIONS,
  TELEMETRY_GET_TURNS: TELEMETRY_CHANNELS.GET_TURNS,
  TELEMETRY_GET_TURN_DETAIL: TELEMETRY_CHANNELS.GET_TURN_DETAIL,
  TELEMETRY_GET_TOOL_STATS: TELEMETRY_CHANNELS.GET_TOOL_STATS,
  TELEMETRY_GET_INTENT_DIST: TELEMETRY_CHANNELS.GET_INTENT_DIST,
  TELEMETRY_GET_EVENTS: TELEMETRY_CHANNELS.GET_EVENTS,
  TELEMETRY_GET_SYSTEM_PROMPT: TELEMETRY_CHANNELS.GET_SYSTEM_PROMPT,
  TELEMETRY_DELETE_SESSION: TELEMETRY_CHANNELS.DELETE_SESSION,
  TELEMETRY_EVENT: TELEMETRY_CHANNELS.EVENT,
} as const;

// ----------------------------------------------------------------------------
// Renderer -> Main: Invoke handlers (request/response)
// ----------------------------------------------------------------------------

export interface IpcInvokeHandlers {
  // Agent - 支持纯文本或带附件的消息
  [IPC_CHANNELS.AGENT_SEND_MESSAGE]: (message: string | AgentMessageRequest) => Promise<void>;
  [IPC_CHANNELS.AGENT_CANCEL]: () => Promise<void>;
  [IPC_CHANNELS.AGENT_PERMISSION_RESPONSE]: (
    requestId: string,
    response: PermissionResponse
  ) => Promise<void>;

  // Generation
  [IPC_CHANNELS.GENERATION_LIST]: () => Promise<Generation[]>;
  [IPC_CHANNELS.GENERATION_SWITCH]: (id: GenerationId) => Promise<Generation>;
  [IPC_CHANNELS.GENERATION_GET_PROMPT]: (id: GenerationId) => Promise<string>;
  [IPC_CHANNELS.GENERATION_COMPARE]: (
    id1: GenerationId,
    id2: GenerationId
  ) => Promise<GenerationDiff>;
  [IPC_CHANNELS.GENERATION_GET_CURRENT]: () => Promise<Generation>;

  // Session
  [IPC_CHANNELS.SESSION_LIST]: (options?: { includeArchived?: boolean }) => Promise<Session[]>;
  [IPC_CHANNELS.SESSION_CREATE]: (title?: string) => Promise<Session>;
  [IPC_CHANNELS.SESSION_LOAD]: (id: string) => Promise<Session>;
  [IPC_CHANNELS.SESSION_DELETE]: (id: string) => Promise<void>;
  [IPC_CHANNELS.SESSION_GET_MESSAGES]: (sessionId: string) => Promise<Message[]>;
  [IPC_CHANNELS.SESSION_EXPORT]: (sessionId: string) => Promise<SessionExport>;
  [IPC_CHANNELS.SESSION_IMPORT]: (data: SessionExport) => Promise<string>;
  [IPC_CHANNELS.SESSION_ARCHIVE]: (sessionId: string) => Promise<Session>;
  [IPC_CHANNELS.SESSION_UNARCHIVE]: (sessionId: string) => Promise<Session>;

  // Memory (legacy - kept for compatibility)
  [IPC_CHANNELS.MEMORY_GET_CONTEXT]: (query: string) => Promise<MemoryContextResult>;
  [IPC_CHANNELS.MEMORY_SEARCH_CODE]: (query: string, topK?: number) => Promise<SearchResult[]>;
  [IPC_CHANNELS.MEMORY_SEARCH_CONVERSATIONS]: (query: string, topK?: number) => Promise<SearchResult[]>;
  [IPC_CHANNELS.MEMORY_GET_STATS]: () => Promise<MemoryStats>;

  // MCP
  [IPC_CHANNELS.MCP_GET_STATUS]: () => Promise<MCPStatus>;
  [IPC_CHANNELS.MCP_LIST_TOOLS]: () => Promise<MCPTool[]>;
  [IPC_CHANNELS.MCP_LIST_RESOURCES]: () => Promise<MCPResource[]>;

  // Workspace
  [IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY]: () => Promise<string | null>;
  [IPC_CHANNELS.WORKSPACE_LIST_FILES]: (path: string) => Promise<FileInfo[]>;
  [IPC_CHANNELS.WORKSPACE_READ_FILE]: (path: string) => Promise<string>;
  [IPC_CHANNELS.WORKSPACE_GET_CURRENT]: () => Promise<string | null>;

  // Shell
  [IPC_CHANNELS.SHELL_OPEN_PATH]: (path: string) => Promise<string>;

  // Settings
  [IPC_CHANNELS.SETTINGS_GET]: () => Promise<AppSettings>;
  [IPC_CHANNELS.SETTINGS_SET]: (settings: Partial<AppSettings>) => Promise<void>;
  [IPC_CHANNELS.SETTINGS_TEST_API_KEY]: (
    provider: string,
    apiKey: string
  ) => Promise<boolean>;
  [IPC_CHANNELS.SETTINGS_GET_SERVICE_KEYS]: () => Promise<{
    brave?: string;
    github?: string;
    openrouter?: string;
    langfuse_public?: string;
    langfuse_secret?: string;
    exa?: string;
    perplexity?: string;
  }>;
  [IPC_CHANNELS.SETTINGS_SET_SERVICE_KEY]: (payload: {
    service: 'brave' | 'github' | 'openrouter' | 'langfuse_public' | 'langfuse_secret' | 'exa' | 'perplexity';
    apiKey: string;
  }) => Promise<void>;
  [IPC_CHANNELS.SETTINGS_GET_INTEGRATION]: (integration: string) => Promise<Record<string, string> | null>;
  [IPC_CHANNELS.SETTINGS_SET_INTEGRATION]: (payload: {
    integration: string;
    config: Record<string, string>;
  }) => Promise<void>;

  // Window
  [IPC_CHANNELS.WINDOW_MINIMIZE]: () => Promise<void>;
  [IPC_CHANNELS.WINDOW_MAXIMIZE]: () => Promise<void>;
  [IPC_CHANNELS.WINDOW_CLOSE]: () => Promise<void>;

  // App
  [IPC_CHANNELS.APP_GET_VERSION]: () => Promise<string>;

  // Planning (Gen 3+ persistent planning)
  [IPC_CHANNELS.PLANNING_GET_STATE]: () => Promise<PlanningState>;
  [IPC_CHANNELS.PLANNING_GET_PLAN]: () => Promise<TaskPlan | null>;
  [IPC_CHANNELS.PLANNING_GET_FINDINGS]: () => Promise<Finding[]>;
  [IPC_CHANNELS.PLANNING_GET_ERRORS]: () => Promise<ErrorRecord[]>;

  // User question (Gen 3+ ask_user_question)
  [IPC_CHANNELS.USER_QUESTION_RESPONSE]: (response: UserQuestionResponse) => Promise<void>;

  // Confirm action (Gen 3+ confirm_action)
  [IPC_CHANNELS.CONFIRM_ACTION_RESPONSE]: (response: { requestId: string; confirmed: boolean }) => Promise<void>;

  // Auth
  [IPC_CHANNELS.AUTH_GET_STATUS]: () => Promise<AuthStatus>;
  [IPC_CHANNELS.AUTH_SIGN_IN_EMAIL]: (
    email: string,
    password: string
  ) => Promise<{ success: boolean; user?: AuthUser; error?: string }>;
  [IPC_CHANNELS.AUTH_SIGN_UP_EMAIL]: (
    email: string,
    password: string,
    inviteCode?: string
  ) => Promise<{ success: boolean; user?: AuthUser; error?: string }>;
  [IPC_CHANNELS.AUTH_SIGN_IN_OAUTH]: (provider: 'github' | 'google') => Promise<void>;
  [IPC_CHANNELS.AUTH_SIGN_IN_TOKEN]: (
    token: string
  ) => Promise<{ success: boolean; user?: AuthUser; error?: string }>;
  [IPC_CHANNELS.AUTH_SIGN_OUT]: () => Promise<void>;
  [IPC_CHANNELS.AUTH_GET_USER]: () => Promise<AuthUser | null>;
  [IPC_CHANNELS.AUTH_UPDATE_PROFILE]: (
    updates: Partial<AuthUser>
  ) => Promise<{ success: boolean; user?: AuthUser; error?: string }>;
  [IPC_CHANNELS.AUTH_GENERATE_QUICK_TOKEN]: () => Promise<string | null>;
  [IPC_CHANNELS.AUTH_RESET_PASSWORD]: (
    email: string
  ) => Promise<{ success: boolean; error?: string }>;
  [IPC_CHANNELS.AUTH_UPDATE_PASSWORD]: (
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;

  // Sync
  [IPC_CHANNELS.SYNC_GET_STATUS]: () => Promise<SyncStatus>;
  [IPC_CHANNELS.SYNC_START]: () => Promise<void>;
  [IPC_CHANNELS.SYNC_STOP]: () => Promise<void>;
  [IPC_CHANNELS.SYNC_FORCE_FULL]: () => Promise<{ success: boolean; error?: string }>;
  [IPC_CHANNELS.SYNC_RESOLVE_CONFLICT]: (
    conflictId: string,
    resolution: 'local' | 'remote' | 'merge'
  ) => Promise<void>;

  // Device
  [IPC_CHANNELS.DEVICE_REGISTER]: () => Promise<DeviceInfo>;
  [IPC_CHANNELS.DEVICE_LIST]: () => Promise<DeviceInfo[]>;
  [IPC_CHANNELS.DEVICE_REMOVE]: (deviceId: string) => Promise<void>;

  // Update
  [IPC_CHANNELS.UPDATE_CHECK]: () => Promise<UpdateInfo>;
  [IPC_CHANNELS.UPDATE_GET_INFO]: () => Promise<UpdateInfo | null>;
  [IPC_CHANNELS.UPDATE_DOWNLOAD]: (downloadUrl: string) => Promise<string>;
  [IPC_CHANNELS.UPDATE_OPEN_FILE]: (filePath: string) => Promise<void>;
  [IPC_CHANNELS.UPDATE_OPEN_URL]: (url: string) => Promise<void>;
  [IPC_CHANNELS.UPDATE_START_AUTO_CHECK]: () => Promise<void>;
  [IPC_CHANNELS.UPDATE_STOP_AUTO_CHECK]: () => Promise<void>;

  // Cache
  [IPC_CHANNELS.CACHE_GET_STATS]: () => Promise<CacheStats>;
  [IPC_CHANNELS.CACHE_CLEAR]: () => Promise<void>;
  [IPC_CHANNELS.CACHE_CLEAN_EXPIRED]: () => Promise<number>;

  // Data management
  [IPC_CHANNELS.DATA_GET_STATS]: () => Promise<DataStats>;
  [IPC_CHANNELS.DATA_CLEAR_TOOL_CACHE]: () => Promise<number>;

  // Persistent settings (survive data clear)
  [IPC_CHANNELS.PERSISTENT_GET_DEV_MODE]: () => Promise<boolean>;
  [IPC_CHANNELS.PERSISTENT_SET_DEV_MODE]: (enabled: boolean) => Promise<void>;

  // Permission mode
  [IPC_CHANNELS.PERMISSION_GET_MODE]: () => Promise<string>;
  [IPC_CHANNELS.PERMISSION_SET_MODE]: (mode: string) => Promise<boolean>;

  // Security
  [IPC_CHANNELS.SECURITY_CHECK_API_KEY_CONFIGURED]: () => Promise<boolean>;
  [IPC_CHANNELS.SECURITY_TOOL_CREATE_RESPONSE]: (requestId: string, allowed: boolean) => Promise<void>;

  // Cloud config
  [IPC_CHANNELS.CLOUD_CONFIG_REFRESH]: () => Promise<{ success: boolean; version: string; error?: string }>;
  [IPC_CHANNELS.CLOUD_CONFIG_GET_INFO]: () => Promise<{ version: string; lastFetch: number; isStale: boolean; fromCloud: boolean; lastError: string | null }>;

  // Memory (Phase 2/3)
  [IPC_CHANNELS.MEMORY]: (payload: {
    action: 'list' | 'update' | 'delete' | 'deleteByCategory' | 'export' | 'import' | 'getStats' | 'add' | 'getLearningInsights';
    category?: MemoryCategory;
    id?: string;
    content?: string;
    data?: MemoryExport;
    item?: Partial<MemoryItem>;
  }) => Promise<{
    success: boolean;
    data?: MemoryItem[] | MemoryStatsNew | MemoryExport | { deleted: number } | { imported: number; skipped: number } | MemoryItem;
    error?: string;
  }>;
  [IPC_CHANNELS.MEMORY_CONFIRM_RESPONSE]: (payload: { id: string; confirmed: boolean }) => Promise<void>;

  // Cloud task
  [IPC_CHANNELS.CLOUD_TASK_CREATE]: (request: CreateCloudTaskRequest) => Promise<CloudTask>;
  [IPC_CHANNELS.CLOUD_TASK_UPDATE]: (taskId: string, updates: Partial<CloudTask>) => Promise<CloudTask | null>;
  [IPC_CHANNELS.CLOUD_TASK_CANCEL]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.CLOUD_TASK_GET]: (taskId: string) => Promise<CloudTask | null>;
  [IPC_CHANNELS.CLOUD_TASK_LIST]: (filter?: CloudTaskFilter) => Promise<CloudTask[]>;
  [IPC_CHANNELS.CLOUD_TASK_DELETE]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.CLOUD_TASK_START]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.CLOUD_TASK_PAUSE]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.CLOUD_TASK_RESUME]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.CLOUD_TASK_RETRY]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.CLOUD_TASK_SYNC]: () => Promise<void>;
  [IPC_CHANNELS.CLOUD_TASK_SYNC_STATE]: () => Promise<TaskSyncState>;
  [IPC_CHANNELS.CLOUD_TASK_STATS]: () => Promise<CloudExecutionStats>;

  // Context health
  [IPC_CHANNELS.CONTEXT_HEALTH_GET]: (sessionId?: string) => Promise<ContextHealthState>;

  // Session status (multi-session parallel support)
  [IPC_CHANNELS.SESSION_STATUS_GET]: (sessionId: string) => Promise<SessionRuntimeSummary | null>;
  [IPC_CHANNELS.SESSION_STATUS_GET_ALL]: () => Promise<SessionRuntimeSummary[]>;

  // Skill Marketplace
  [IPC_CHANNELS.MARKETPLACE_LIST]: () => Promise<MarketplaceResult<MarketplaceInfo[]>>;
  [IPC_CHANNELS.MARKETPLACE_ADD]: (url: string) => Promise<MarketplaceResult<MarketplaceInfo>>;
  [IPC_CHANNELS.MARKETPLACE_REMOVE]: (id: string) => Promise<MarketplaceResult<void>>;
  [IPC_CHANNELS.MARKETPLACE_REFRESH]: (id?: string) => Promise<MarketplaceResult<void>>;
  [IPC_CHANNELS.MARKETPLACE_INFO]: (id: string) => Promise<MarketplaceResult<MarketplaceInfo>>;
  [IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS]: (marketplaceId?: string) => Promise<MarketplaceResult<MarketplacePluginEntry[]>>;
  [IPC_CHANNELS.MARKETPLACE_SEARCH_PLUGINS]: (query: string) => Promise<MarketplaceResult<MarketplacePluginEntry[]>>;
  [IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN]: (spec: string, options?: { scope?: 'user' | 'project'; projectPath?: string }) => Promise<PluginInstallResult>;
  [IPC_CHANNELS.MARKETPLACE_UNINSTALL_PLUGIN]: (pluginId: string, scope?: 'user' | 'project') => Promise<MarketplaceResult<void>>;
  [IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED]: (scope?: 'user' | 'project' | 'all') => Promise<MarketplaceResult<InstalledPlugin[]>>;
  [IPC_CHANNELS.MARKETPLACE_ENABLE_PLUGIN]: (pluginId: string) => Promise<MarketplaceResult<void>>;
  [IPC_CHANNELS.MARKETPLACE_DISABLE_PLUGIN]: (pluginId: string) => Promise<MarketplaceResult<void>>;

  // Lab (实验室)
  [IPC_CHANNELS.LAB_DOWNLOAD_PROJECT]: (request: DownloadProjectRequest) => Promise<DownloadProjectResponse>;
  [IPC_CHANNELS.LAB_UPLOAD_DATA]: (request: UploadDataRequest) => Promise<UploadDataResponse>;
  [IPC_CHANNELS.LAB_START_TRAINING]: (request: StartTrainingRequest) => Promise<StartTrainingResponse>;
  [IPC_CHANNELS.LAB_STOP_TRAINING]: (projectType: LabProjectType) => Promise<{ success: boolean; error?: string }>;
  [IPC_CHANNELS.LAB_INFERENCE]: (request: InferenceRequest) => Promise<InferenceResult>;
  [IPC_CHANNELS.LAB_GET_PROJECT_STATUS]: (projectType: LabProjectType) => Promise<LabProjectStatus>;
  [IPC_CHANNELS.LAB_CHECK_PYTHON_ENV]: () => Promise<PythonEnvStatus>;

  // Channel (多通道接入)
  [IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS]: () => Promise<ChannelAccount[]>;
  [IPC_CHANNELS.CHANNEL_GET_TYPES]: () => Promise<Array<{ type: ChannelType; name: string; description?: string }>>;
  [IPC_CHANNELS.CHANNEL_ADD_ACCOUNT]: (request: AddChannelAccountRequest) => Promise<ChannelAccount>;
  [IPC_CHANNELS.CHANNEL_UPDATE_ACCOUNT]: (request: UpdateChannelAccountRequest) => Promise<ChannelAccount | null>;
  [IPC_CHANNELS.CHANNEL_DELETE_ACCOUNT]: (accountId: string) => Promise<boolean>;
  [IPC_CHANNELS.CHANNEL_CONNECT_ACCOUNT]: (accountId: string) => Promise<{ success: boolean; error?: string }>;
  [IPC_CHANNELS.CHANNEL_DISCONNECT_ACCOUNT]: (accountId: string) => Promise<{ success: boolean; error?: string }>;

  // Evaluation (会话评测)
  [IPC_CHANNELS.EVALUATION_RUN]: (payload: { sessionId: string; save?: boolean }) => Promise<EvaluationResult>;
  [IPC_CHANNELS.EVALUATION_GET_RESULT]: (evaluationId: string) => Promise<EvaluationResult | null>;
  [IPC_CHANNELS.EVALUATION_LIST_HISTORY]: (payload?: { sessionId?: string; limit?: number }) => Promise<EvaluationResult[]>;
  [IPC_CHANNELS.EVALUATION_EXPORT]: (payload: { result: EvaluationResult; format: 'json' | 'markdown' }) => Promise<string>;
  [IPC_CHANNELS.EVALUATION_DELETE]: (evaluationId: string) => Promise<boolean>;
  // Session Analytics (v2 - 分离客观指标和主观评测)
  [IPC_CHANNELS.EVALUATION_GET_OBJECTIVE_METRICS]: (sessionId: string) => Promise<ObjectiveMetrics>;
  [IPC_CHANNELS.EVALUATION_GET_SESSION_ANALYSIS]: (sessionId: string) => Promise<SessionAnalysisResult>;
  [IPC_CHANNELS.EVALUATION_RUN_SUBJECTIVE]: (payload: { sessionId: string; save?: boolean }) => Promise<SubjectiveAssessment>;

  // Background (后台任务)
  [IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND]: (sessionId: string) => Promise<boolean>;
  [IPC_CHANNELS.BACKGROUND_MOVE_TO_FOREGROUND]: (sessionId: string) => Promise<BackgroundTaskInfo | null>;
  [IPC_CHANNELS.BACKGROUND_GET_TASKS]: () => Promise<BackgroundTaskInfo[]>;
  [IPC_CHANNELS.BACKGROUND_GET_COUNT]: () => Promise<number>;

  // Swarm (Agent Teams)
  [IPC_CHANNELS.SWARM_SEND_USER_MESSAGE]: (payload: { agentId: string; message: string }) => Promise<void>;
  [IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES]: (agentId: string) => Promise<Array<{ from: string; to: string; content: string; timestamp: number }>>;
  [IPC_CHANNELS.SWARM_SET_DELEGATE_MODE]: (enabled: boolean) => Promise<void>;

  // TaskList (任务列表可视化)
  [IPC_CHANNELS.TASKLIST_GET_STATE]: () => Promise<TaskListStateIpc>;
  [IPC_CHANNELS.TASKLIST_GET_TASKS]: () => Promise<TaskItemIpc[]>;
  [IPC_CHANNELS.TASKLIST_UPDATE_TASK]: (taskId: string, changes: Partial<TaskItemIpc>) => Promise<TaskItemIpc | null>;
  [IPC_CHANNELS.TASKLIST_REASSIGN]: (taskId: string, assignee: string) => Promise<TaskItemIpc | null>;
  [IPC_CHANNELS.TASKLIST_APPROVE]: (taskId: string) => Promise<void>;
  [IPC_CHANNELS.TASKLIST_APPROVE_ALL]: () => Promise<void>;
  [IPC_CHANNELS.TASKLIST_DELETE_TASK]: (taskId: string) => Promise<boolean>;
  [IPC_CHANNELS.TASKLIST_SET_AUTO_ASSIGN]: (enabled: boolean) => Promise<void>;
  [IPC_CHANNELS.TASKLIST_SET_REQUIRE_APPROVAL]: (enabled: boolean) => Promise<void>;

  // Telemetry (遥测系统)
  [IPC_CHANNELS.TELEMETRY_GET_SESSION]: (sessionId: string) => Promise<TelemetrySession | null>;
  [IPC_CHANNELS.TELEMETRY_LIST_SESSIONS]: (options: { limit?: number; offset?: number }) => Promise<TelemetrySessionListItem[]>;
  [IPC_CHANNELS.TELEMETRY_GET_TURNS]: (sessionId: string) => Promise<TelemetryTurn[]>;
  [IPC_CHANNELS.TELEMETRY_GET_TURN_DETAIL]: (turnId: string) => Promise<{ turn: TelemetryTurn; modelCalls: TelemetryModelCall[]; toolCalls: TelemetryToolCall[]; events: TelemetryTimelineEvent[] } | null>;
  [IPC_CHANNELS.TELEMETRY_GET_TOOL_STATS]: (sessionId: string) => Promise<TelemetryToolStat[]>;
  [IPC_CHANNELS.TELEMETRY_GET_INTENT_DIST]: (sessionId: string) => Promise<TelemetryIntentStat[]>;
  [IPC_CHANNELS.TELEMETRY_GET_EVENTS]: (sessionId: string) => Promise<TelemetryTimelineEvent[]>;
  [IPC_CHANNELS.TELEMETRY_GET_SYSTEM_PROMPT]: (hash: string) => Promise<{ content: string; tokens: number | null; generationId: string | null } | null>;
  [IPC_CHANNELS.TELEMETRY_DELETE_SESSION]: (sessionId: string) => Promise<boolean>;
}

// ----------------------------------------------------------------------------
// Main -> Renderer: Event handlers (one-way)
// ----------------------------------------------------------------------------

export type PlanningEventType = 'plan_updated' | 'findings_updated' | 'errors_updated';

export interface PlanningEvent {
  type: PlanningEventType;
  data: PlanningState;
}

export type AuthEventType = 'signed_in' | 'signed_out' | 'token_refreshed' | 'user_updated';

export interface AuthEvent {
  type: AuthEventType;
  user?: AuthUser;
}

export interface SessionUpdatedEvent {
  sessionId: string;
  updates: Partial<Session>;
}

export type UpdateEventType = 'update_available' | 'download_progress' | 'download_complete' | 'download_error';

export interface UpdateEvent {
  type: UpdateEventType;
  data?: UpdateInfo | DownloadProgress | { filePath: string } | { error: string };
}

export interface NotificationClickedEvent {
  sessionId: string;
}

export type MCPEventType = 'connection_errors' | 'server_connected' | 'server_disconnected';

export interface MCPEvent {
  type: MCPEventType;
  data?: { server: string; error?: string }[];
}

export interface ToolCreateRequestEvent {
  id: string;
  name: string;
  description: string;
  type: string;
  code?: string;
  script?: string;
}

export interface ConfirmActionRequest {
  id: string;
  title: string;
  message: string;
  type: 'danger' | 'warning' | 'info';
  confirmText: string;
  cancelText: string;
  timestamp: number;
}

export interface IpcEventHandlers {
  [IPC_CHANNELS.AGENT_EVENT]: (event: AgentEvent) => void;
  [IPC_CHANNELS.MEMORY_LEARNED]: (event: MemoryLearnedEvent) => void;
  [IPC_CHANNELS.MEMORY_CONFIRM_REQUEST]: (request: MemoryConfirmRequest) => void;
  [IPC_CHANNELS.PLANNING_EVENT]: (event: PlanningEvent) => void;
  [IPC_CHANNELS.SECURITY_TOOL_CREATE_REQUEST]: (request: ToolCreateRequestEvent) => void;
  [IPC_CHANNELS.USER_QUESTION_ASK]: (request: UserQuestionRequest) => void;
  [IPC_CHANNELS.CONFIRM_ACTION_ASK]: (request: ConfirmActionRequest) => void;
  [IPC_CHANNELS.AUTH_EVENT]: (event: AuthEvent) => void;
  [IPC_CHANNELS.AUTH_PASSWORD_RESET_CALLBACK]: (data: { accessToken: string; refreshToken: string }) => void;
  [IPC_CHANNELS.SYNC_EVENT]: (status: SyncStatus) => void;
  [IPC_CHANNELS.SESSION_UPDATED]: (event: SessionUpdatedEvent) => void;
  [IPC_CHANNELS.SESSION_LIST_UPDATED]: () => void;
  [IPC_CHANNELS.UPDATE_EVENT]: (event: UpdateEvent) => void;
  [IPC_CHANNELS.NOTIFICATION_CLICKED]: (event: NotificationClickedEvent) => void;
  [IPC_CHANNELS.MCP_EVENT]: (event: MCPEvent) => void;
  [IPC_CHANNELS.CLOUD_TASK_PROGRESS]: (event: TaskProgressEvent) => void;
  [IPC_CHANNELS.CLOUD_TASK_COMPLETED]: (task: CloudTask) => void;
  [IPC_CHANNELS.CLOUD_TASK_FAILED]: (task: CloudTask) => void;
  [IPC_CHANNELS.CONTEXT_HEALTH_EVENT]: (event: ContextHealthUpdateEvent) => void;
  [IPC_CHANNELS.SESSION_STATUS_UPDATE]: (event: SessionStatusUpdateEvent) => void;
  // Background task events
  [IPC_CHANNELS.BACKGROUND_TASK_UPDATE]: (event: BackgroundTaskUpdateEvent) => void;
  // DAG Visualization events
  [DAG_CHANNELS.EVENT]: (event: DAGVisualizationEvent) => void;
  // Lab training progress events
  [IPC_CHANNELS.LAB_TRAINING_PROGRESS]: (event: TrainingProgressEvent) => void;
  // Channel events
  [IPC_CHANNELS.CHANNEL_ACCOUNTS_CHANGED]: (accounts: ChannelAccount[]) => void;
  [IPC_CHANNELS.CHANNEL_ACCOUNT_STATUS_CHANGED]: (event: { accountId: string; status: string; error?: string }) => void;
  // Swarm events
  [IPC_CHANNELS.SWARM_EVENT]: (event: SwarmEvent) => void;
  // TaskList events
  [IPC_CHANNELS.TASKLIST_EVENT]: (event: TaskListEventIpc) => void;
  // Telemetry events
  [IPC_CHANNELS.TELEMETRY_EVENT]: (event: TelemetryPushEvent) => void;
}

// ----------------------------------------------------------------------------
// Preload API exposed to renderer
// ----------------------------------------------------------------------------

export interface ElectronAPI {
  // Invoke methods (async request/response)
  invoke: <K extends keyof IpcInvokeHandlers>(
    channel: K,
    ...args: Parameters<IpcInvokeHandlers[K]>
  ) => ReturnType<IpcInvokeHandlers[K]>;

  // Event listeners
  on: <K extends keyof IpcEventHandlers>(
    channel: K,
    callback: IpcEventHandlers[K]
  ) => () => void;

  // Remove event listener
  off: <K extends keyof IpcEventHandlers>(
    channel: K,
    callback: IpcEventHandlers[K]
  ) => void;

  // Electron 33+ 获取文件的本地路径
  getPathForFile: (file: File) => string;

  // PDF 文本提取（在主进程处理）
  extractPdfText: (filePath: string) => Promise<{ text: string; pageCount: number }>;

  // Excel 文本提取（使用 xlsx 库）
  extractExcelText: (filePath: string) => Promise<{ text: string; sheetCount: number; rowCount: number }>;

  // 语音转写（使用 Groq Whisper API）
  transcribeSpeech: (audioData: string, mimeType: string) => Promise<{
    success: boolean;
    text?: string;
    error?: string;
    hallucination?: boolean;
  }>;
}

/**
 * Domain API exposed to renderer (new unified API)
 */
export interface DomainAPI {
  invoke: <T = unknown>(
    domain: string,
    action: string,
    payload?: unknown
  ) => Promise<IPCResponse<T>>;
}

// Note: Window.electronAPI and Window.domainAPI are declared in src/renderer/types/electron.d.ts
