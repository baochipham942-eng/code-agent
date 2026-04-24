// ============================================================================
// IPC Handlers - Invoke + Event handler 接口定义
// ============================================================================

import type {
  Message,
  PermissionResponse,
  Session,
  FileInfo,
  AppSettings,
  AgentEvent,
  TaskPlan,
  Finding,
  ErrorRecord,
  PlanningState,
  UserQuestionRequest,
  UserQuestionResponse,
  MCPElicitationRequest,
  MCPElicitationResponse,
  AuthUser,
  AuthStatus,
  SyncStatus,
  DeviceInfo,
  UpdateInfo,
  DownloadProgress,
} from '../contract';

import type {
  CloudTask,
  CreateCloudTaskRequest,
  CloudTaskFilter,
  TaskProgressEvent,
  TaskSyncState,
  CloudExecutionStats,
} from '../contract/cloud';

import type {
  MemoryItem,
  MemoryCategory,
  MemoryStats as MemoryStatsNew,
  MemoryExport,
  MemoryLearnedEvent,
  MemoryConfirmRequest,
} from '../contract/memory';

import type {
  ContextHealthState,
  ContextHealthUpdateEvent,
} from '../contract/contextHealth';

import type {
  ContextInterventionRequest,
  ContextInterventionSetRequest,
  ContextInterventionSnapshot,
  ContextViewRequest,
  ContextViewResponse,
} from '../contract/contextView';

import type { DAGVisualizationEvent } from '../contract/dagVisualization';
import { DAG_CHANNELS } from './channels';

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
} from '../contract/telemetry';

import type {
  ObjectiveMetrics,
  SubjectiveAssessment,
} from '../contract/sessionAnalytics';

import type {
  ChannelAccount,
  ChannelType,
  AddChannelAccountRequest,
  UpdateChannelAccountRequest,
} from '../contract/channel';

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
} from '../contract/lab';

import type {
  MarketplaceInfo,
  MarketplacePluginEntry,
  InstalledPlugin,
  MarketplaceResult,
  PluginInstallResult,
} from '../contract/marketplace';

import type {
  EvaluationResult,
} from '../contract/evaluation';
import type {
  EnqueueReviewItemInput,
  ReviewQueueItem,
  UpdateReviewQueueFailureCapabilityAssetInput,
} from '../contract/reviewQueue';

import type {
  SessionRuntimeSummary,
  SessionStatusUpdateEvent,
  BackgroundTaskInfo,
  BackgroundTaskUpdateEvent,
} from '../contract/sessionState';

import type { SwarmEvent } from '../contract/swarm';
import type { SwarmRunListItem, SwarmRunDetail } from '../contract/swarmTrace';
import type { CompletedAgentRun } from '../contract/agentHistory';

import { IPC_CHANNELS } from './legacy-channels';

import type {
  AgentMessageRequest,
  AgentCancelRequest,
  SessionExport,
  SearchResult,
  MemoryContextResult,
  MemoryStats,
  MCPStatus,
  MCPTool,
  MCPResource,
  ConnectorStatusSummary,
  CacheStats,
  DataStats,
  SessionAnalysisResult,
  TestReportListItem,
  TestRunReport,
  EvalAnnotationPayload,
  AxialCodingEntryIpc,
  TaskItemIpc,
  TaskListStateIpc,
  TaskListEventIpc,
  CrossSessionSearchOptions,
  CrossSessionSearchResults,
} from './types';

// ----------------------------------------------------------------------------
// Renderer -> Main: Invoke handlers (request/response)
// ----------------------------------------------------------------------------

export interface IpcInvokeHandlers {
  // Agent - 支持纯文本或带附件的消息
  [IPC_CHANNELS.AGENT_SEND_MESSAGE]: (message: string | AgentMessageRequest) => Promise<void>;
  [IPC_CHANNELS.AGENT_CANCEL]: (payload?: AgentCancelRequest) => Promise<void>;
  [IPC_CHANNELS.AGENT_PERMISSION_RESPONSE]: (
    requestId: string,
    response: PermissionResponse,
    sessionId?: string
  ) => Promise<void>;


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
  [IPC_CHANNELS.SESSION_LOAD_OLDER_MESSAGES]: (payload: { sessionId: string; beforeTimestamp: number; limit?: number }) => Promise<{ messages: Message[]; hasMore: boolean }>;
  [IPC_CHANNELS.SESSION_SEARCH]: (payload: { query: string; options?: CrossSessionSearchOptions }) => Promise<CrossSessionSearchResults>;

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

  // MCP Elicitation (server requests user input)
  [IPC_CHANNELS.MCP_ELICITATION_RESPONSE]: (response: MCPElicitationResponse) => Promise<void>;

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
    action: 'list' | 'update' | 'delete' | 'deleteByCategory' | 'export' | 'import' | 'getStats' | 'add' | 'getLearningInsights' | 'lightList' | 'lightRead' | 'lightDelete' | 'lightStats';
    category?: MemoryCategory;
    id?: string;
    content?: string;
    data?: MemoryExport;
    item?: Partial<MemoryItem>;
    filename?: string;
  }) => Promise<{
    success: boolean;
    data?: MemoryItem[] | MemoryStatsNew | MemoryExport | { deleted: number } | { imported: number; skipped: number } | MemoryItem | unknown;
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
  [IPC_CHANNELS.EVALUATION_LIST_TEST_REPORTS]: () => Promise<TestReportListItem[]>;
  [IPC_CHANNELS.EVALUATION_LOAD_TEST_REPORT]: (filePath: string) => Promise<TestRunReport>;
  [IPC_CHANNELS.EVALUATION_SAVE_ANNOTATIONS]: (annotation: EvalAnnotationPayload) => Promise<{ success: boolean; error?: string }>;
  [IPC_CHANNELS.EVALUATION_GET_AXIAL_CODING]: () => Promise<AxialCodingEntryIpc[]>;
  [IPC_CHANNELS.EVALUATION_LIST_TEST_CASES]: () => Promise<unknown[]>;
  [IPC_CHANNELS.EVALUATION_GET_SCORING_CONFIG]: () => Promise<unknown[]>;
  [IPC_CHANNELS.EVALUATION_UPDATE_SCORING_CONFIG]: (config: unknown) => Promise<{ success: boolean }>;
  [IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS]: (limit?: number) => Promise<unknown[]>;
  [IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT]: (id: string) => Promise<unknown>;
  [IPC_CHANNELS.EVALUATION_GET_FAILURE_FUNNEL]: (experimentId: string) => Promise<unknown>;
  [IPC_CHANNELS.EVALUATION_GET_CROSS_EXPERIMENT]: (experimentIds: string[]) => Promise<unknown[]>;
  [IPC_CHANNELS.EVALUATION_CREATE_EXPERIMENT]: (config: { name: string; model: string; testSetId: string; trialsPerCase: number; gitCommit: string }) => Promise<{ experimentId: string; status: string }>;
  [IPC_CHANNELS.EVALUATION_GET_GIT_COMMIT]: () => Promise<{ hash: string; short: string }>;
  [IPC_CHANNELS.EVALUATION_GET_SNAPSHOT]: (sessionId: string) => Promise<unknown>;
  [IPC_CHANNELS.EVALUATION_BUILD_SNAPSHOT]: (sessionId: string) => Promise<unknown>;
  [IPC_CHANNELS.EVALUATION_GET_CASE_DETAIL]: (experimentId: string, caseId: string) => Promise<unknown>;
  [IPC_CHANNELS.EVALUATION_REVIEW_QUEUE_LIST]: () => Promise<ReviewQueueItem[]>;
  [IPC_CHANNELS.EVALUATION_REVIEW_QUEUE_ENQUEUE]: (payload: EnqueueReviewItemInput) => Promise<ReviewQueueItem>;
  [IPC_CHANNELS.EVALUATION_REVIEW_QUEUE_UPDATE_FAILURE_ASSET]: (payload: UpdateReviewQueueFailureCapabilityAssetInput) => Promise<ReviewQueueItem | null>;

  // Test Subset (数据集子集管理)
  [IPC_CHANNELS.SUBSET_SAVE]: (subset: { name: string; description?: string; caseIds: string[] }) => Promise<{ success: boolean; path: string }>;
  [IPC_CHANNELS.SUBSET_LIST]: () => Promise<Array<{ name: string; description?: string; caseIds: string[]; createdAt: number; fileName: string }>>;
  [IPC_CHANNELS.SUBSET_LOAD]: (fileName: string) => Promise<{ name: string; description?: string; caseIds: string[]; createdAt: number } | null>;
  [IPC_CHANNELS.SUBSET_DELETE]: (fileName: string) => Promise<boolean>;

  // Background (后台任务)
  [IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND]: (sessionId: string) => Promise<boolean>;
  [IPC_CHANNELS.BACKGROUND_MOVE_TO_FOREGROUND]: (sessionId: string) => Promise<BackgroundTaskInfo | null>;
  [IPC_CHANNELS.BACKGROUND_GET_TASKS]: () => Promise<BackgroundTaskInfo[]>;
  [IPC_CHANNELS.BACKGROUND_GET_COUNT]: () => Promise<number>;

  // Swarm (Agent Teams)
  [IPC_CHANNELS.SWARM_SEND_USER_MESSAGE]: (payload: {
    agentId: string;
    message: string;
    sessionId?: string;
    messageId?: string;
    timestamp?: number;
    metadata?: Message['metadata'];
  }) => Promise<{ delivered: boolean; persisted: boolean }>;
  [IPC_CHANNELS.SWARM_GET_AGENT_MESSAGES]: (agentId: string) => Promise<Array<{ from: string; to: string; content: string; timestamp: number }>>;
  [IPC_CHANNELS.SWARM_SET_DELEGATE_MODE]: (enabled: boolean) => Promise<void>;
  [IPC_CHANNELS.SWARM_GET_DELEGATE_MODE]: () => Promise<boolean>;
  [IPC_CHANNELS.SWARM_APPROVE_LAUNCH]: (payload: { requestId: string; feedback?: string }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_REJECT_LAUNCH]: (payload: { requestId: string; feedback: string }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_CANCEL_AGENT]: (payload: { agentId: string }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_RETRY_AGENT]: (payload: { agentId: string }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_APPROVE_PLAN]: (payload: { planId: string; feedback?: string }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_REJECT_PLAN]: (payload: { planId: string; feedback: string }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_PERSIST_AGENT_RUN]: (payload: { sessionId: string; run: CompletedAgentRun }) => Promise<boolean>;
  [IPC_CHANNELS.SWARM_GET_AGENT_HISTORY]: (payload?: { limit?: number }) => Promise<CompletedAgentRun[]>;
  [IPC_CHANNELS.SWARM_LIST_TRACE_RUNS]: (payload?: { limit?: number }) => Promise<SwarmRunListItem[]>;
  [IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL]: (payload: { runId: string }) => Promise<SwarmRunDetail | null>;

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

  // Checkpoint (Rewind UI)
  [IPC_CHANNELS.CHECKPOINT_LIST]: (sessionId: string) => Promise<Array<{
    id: string;
    timestamp: number;
    messageId: string;
    description?: string;
    fileCount: number;
  }>>;
  [IPC_CHANNELS.CHECKPOINT_REWIND]: (sessionId: string, messageId: string) => Promise<{
    success: boolean;
    filesRestored: number;
    error?: string;
  }>;
  [IPC_CHANNELS.CHECKPOINT_PREVIEW]: (sessionId: string, messageId: string) => Promise<Array<{
    filePath: string;
    status: 'added' | 'modified' | 'deleted';
  }>>;
  [IPC_CHANNELS.CHECKPOINT_FORK]: (sessionId: string, messageId: string) => Promise<{
    success: boolean;
    filesRestored: number;
    messagesTruncated: number;
    error?: string;
  }>;

  // Suggestions (智能提示)
  [IPC_CHANNELS.SUGGESTIONS_GET]: () => Promise<Array<{
    id: string;
    text: string;
    source: string;
  }>>;

  // Context compact (部分压缩)
  [IPC_CHANNELS.CONTEXT_COMPACT_FROM]: (messageId: string) => Promise<import('../../shared/contract/contextHealth').CompactResult>;

  // Context intervention controls (pin/exclude/retain)
  [IPC_CHANNELS.CONTEXT_INTERVENTION_GET]: (request: ContextInterventionRequest) => Promise<ContextInterventionSnapshot>;
  [IPC_CHANNELS.CONTEXT_INTERVENTION_SET]: (request: ContextInterventionSetRequest) => Promise<ContextInterventionSnapshot>;

  // Context observability (/context true-view after projection)
  [IPC_CHANNELS.CONTEXT_GET_VIEW]: (request: ContextViewRequest) => Promise<ContextViewResponse>;

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
  [IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA]: (sessionId: string) => Promise<unknown>;

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

export type ConnectorEventType = 'status_changed';

export interface ConnectorEvent {
  type: ConnectorEventType;
  data: ConnectorStatusSummary[];
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
  [IPC_CHANNELS.MCP_ELICITATION_REQUEST]: (request: MCPElicitationRequest) => void;
  [IPC_CHANNELS.CONFIRM_ACTION_ASK]: (request: ConfirmActionRequest) => void;
  [IPC_CHANNELS.AUTH_EVENT]: (event: AuthEvent) => void;
  [IPC_CHANNELS.AUTH_PASSWORD_RESET_CALLBACK]: (data: { accessToken: string; refreshToken: string }) => void;
  [IPC_CHANNELS.SYNC_EVENT]: (status: SyncStatus) => void;
  [IPC_CHANNELS.SESSION_UPDATED]: (event: SessionUpdatedEvent) => void;
  [IPC_CHANNELS.SESSION_LIST_UPDATED]: () => void;
  [IPC_CHANNELS.WORKSPACE_CURRENT_CHANGED]: (event: { dir: string | null }) => void;
  [IPC_CHANNELS.UPDATE_EVENT]: (event: UpdateEvent) => void;
  [IPC_CHANNELS.NOTIFICATION_CLICKED]: (event: NotificationClickedEvent) => void;
  [IPC_CHANNELS.MCP_EVENT]: (event: MCPEvent) => void;
  [IPC_CHANNELS.CONNECTOR_EVENT]: (event: ConnectorEvent) => void;
  [IPC_CHANNELS.CLOUD_TASK_PROGRESS]: (event: TaskProgressEvent) => void;
  [IPC_CHANNELS.CLOUD_TASK_COMPLETED]: (task: CloudTask) => void;
  [IPC_CHANNELS.CLOUD_TASK_FAILED]: (task: CloudTask) => void;
  [IPC_CHANNELS.CONTEXT_HEALTH_EVENT]: (event: ContextHealthUpdateEvent) => void;
  [IPC_CHANNELS.SESSION_STATUS_UPDATE]: (event: SessionStatusUpdateEvent) => void;
  [IPC_CHANNELS.STATUS_TOKEN_UPDATE]: (event: { inputTokens: number; outputTokens: number }) => void;
  [IPC_CHANNELS.STATUS_CONTEXT_UPDATE]: (event: { percent: number }) => void;
  [IPC_CHANNELS.STATUS_GIT_UPDATE]: (event: { branch: string | null; changes: { staged: number; unstaged: number; untracked: number } | null }) => void;
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
  // Provider fallback events
  [IPC_CHANNELS.PROVIDER_FALLBACK]: (event: ProviderFallbackEvent) => void;
}

export interface ProviderFallbackEvent {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: string;
}
