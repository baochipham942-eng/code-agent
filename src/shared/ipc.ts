// ============================================================================
// IPC Channel Definitions
// Type-safe communication between main and renderer processes
// ============================================================================

import type {
  Generation,
  GenerationId,
  GenerationDiff,
  Message,
  PermissionRequest,
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
  SyncConflict,
  DeviceInfo,
  UpdateInfo,
  DownloadProgress,
} from './types';

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

// ----------------------------------------------------------------------------
// IPC Channel Names
// ----------------------------------------------------------------------------

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

  // Memory channels
  MEMORY_GET_CONTEXT: 'memory:get-context',
  MEMORY_SEARCH_CODE: 'memory:search-code',
  MEMORY_SEARCH_CONVERSATIONS: 'memory:search-conversations',
  MEMORY_GET_STATS: 'memory:get-stats',

  // MCP channels
  MCP_GET_STATUS: 'mcp:get-status',
  MCP_LIST_TOOLS: 'mcp:list-tools',
  MCP_LIST_RESOURCES: 'mcp:list-resources',

  // Workspace channels
  WORKSPACE_SELECT_DIRECTORY: 'workspace:select-directory',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
  WORKSPACE_READ_FILE: 'workspace:read-file',
  WORKSPACE_GET_CURRENT: 'workspace:get-current',

  // Settings channels
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_TEST_API_KEY: 'settings:test-api-key',

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
  AUTH_EVENT: 'auth:event',

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
} as const;

// ----------------------------------------------------------------------------
// Renderer -> Main: Invoke handlers (request/response)
// ----------------------------------------------------------------------------

export interface IpcInvokeHandlers {
  // Agent
  [IPC_CHANNELS.AGENT_SEND_MESSAGE]: (content: string) => Promise<void>;
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
  [IPC_CHANNELS.SESSION_LIST]: () => Promise<Session[]>;
  [IPC_CHANNELS.SESSION_CREATE]: (title?: string) => Promise<Session>;
  [IPC_CHANNELS.SESSION_LOAD]: (id: string) => Promise<Session>;
  [IPC_CHANNELS.SESSION_DELETE]: (id: string) => Promise<void>;
  [IPC_CHANNELS.SESSION_GET_MESSAGES]: (sessionId: string) => Promise<Message[]>;
  [IPC_CHANNELS.SESSION_EXPORT]: (sessionId: string) => Promise<SessionExport>;
  [IPC_CHANNELS.SESSION_IMPORT]: (data: SessionExport) => Promise<string>;

  // Memory
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

  // Settings
  [IPC_CHANNELS.SETTINGS_GET]: () => Promise<AppSettings>;
  [IPC_CHANNELS.SETTINGS_SET]: (settings: Partial<AppSettings>) => Promise<void>;
  [IPC_CHANNELS.SETTINGS_TEST_API_KEY]: (
    provider: string,
    apiKey: string
  ) => Promise<boolean>;

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

export interface IpcEventHandlers {
  [IPC_CHANNELS.AGENT_EVENT]: (event: AgentEvent) => void;
  [IPC_CHANNELS.PLANNING_EVENT]: (event: PlanningEvent) => void;
  [IPC_CHANNELS.USER_QUESTION_ASK]: (request: UserQuestionRequest) => void;
  [IPC_CHANNELS.AUTH_EVENT]: (event: AuthEvent) => void;
  [IPC_CHANNELS.SYNC_EVENT]: (status: SyncStatus) => void;
  [IPC_CHANNELS.SESSION_UPDATED]: (event: SessionUpdatedEvent) => void;
  [IPC_CHANNELS.UPDATE_EVENT]: (event: UpdateEvent) => void;
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
}

// Note: Window.electronAPI is declared in src/renderer/types/electron.d.ts
