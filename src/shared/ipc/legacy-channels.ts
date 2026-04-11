// ============================================================================
// IPC Legacy Channels - 旧版通道常量（保留向后兼容）
// ============================================================================

import {
  DAG_CHANNELS,
  LAB_CHANNELS,
  CHANNEL_CHANNELS,
  EVALUATION_CHANNELS,
  LSP_CHANNELS,
  BACKGROUND_CHANNELS,
  TELEMETRY_CHANNELS,
  SUBSET_CHANNELS,
} from './channels';

// ----------------------------------------------------------------------------
// Legacy IPC Channel Names (Deprecated - use IPC_DOMAINS instead)
// ----------------------------------------------------------------------------

export const IPC_CHANNELS = {
  // Agent channels
  AGENT_SEND_MESSAGE: 'agent:send-message',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_EVENT: 'agent:event',
  AGENT_PERMISSION_RESPONSE: 'agent:permission-response',


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
  SESSION_LOAD_OLDER_MESSAGES: 'session:load-older-messages',

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

  // MCP Elicitation channels (server requests user input)
  MCP_ELICITATION_REQUEST: 'mcp-elicitation:request',
  MCP_ELICITATION_RESPONSE: 'mcp-elicitation:response',

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

  // Status bar update channels
  STATUS_TOKEN_UPDATE: 'status:token-update',
  STATUS_CONTEXT_UPDATE: 'status:context-update',
  STATUS_GIT_UPDATE: 'status:git-update',

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
  EVALUATION_LIST_TEST_REPORTS: EVALUATION_CHANNELS.LIST_TEST_REPORTS,
  EVALUATION_LOAD_TEST_REPORT: EVALUATION_CHANNELS.LOAD_TEST_REPORT,
  EVALUATION_SAVE_ANNOTATIONS: EVALUATION_CHANNELS.SAVE_ANNOTATIONS,
  EVALUATION_GET_AXIAL_CODING: EVALUATION_CHANNELS.GET_AXIAL_CODING,
  EVALUATION_LIST_TEST_CASES: EVALUATION_CHANNELS.LIST_TEST_CASES,
  EVALUATION_GET_SCORING_CONFIG: EVALUATION_CHANNELS.GET_SCORING_CONFIG,
  EVALUATION_UPDATE_SCORING_CONFIG: EVALUATION_CHANNELS.UPDATE_SCORING_CONFIG,
  EVALUATION_LIST_EXPERIMENTS: EVALUATION_CHANNELS.LIST_EXPERIMENTS,
  EVALUATION_LOAD_EXPERIMENT: EVALUATION_CHANNELS.LOAD_EXPERIMENT,
  EVALUATION_GET_FAILURE_FUNNEL: EVALUATION_CHANNELS.GET_FAILURE_FUNNEL,
  EVALUATION_GET_CROSS_EXPERIMENT: EVALUATION_CHANNELS.GET_CROSS_EXPERIMENT,
  EVALUATION_CREATE_EXPERIMENT: EVALUATION_CHANNELS.CREATE_EXPERIMENT,
  EVALUATION_GET_GIT_COMMIT: EVALUATION_CHANNELS.GET_GIT_COMMIT,
  EVALUATION_GET_SNAPSHOT: EVALUATION_CHANNELS.GET_SNAPSHOT,
  EVALUATION_BUILD_SNAPSHOT: EVALUATION_CHANNELS.BUILD_SNAPSHOT,
  EVALUATION_GET_CASE_DETAIL: EVALUATION_CHANNELS.GET_CASE_DETAIL,

  // Test Subset channels (数据集子集管理)
  SUBSET_SAVE: SUBSET_CHANNELS.SAVE,
  SUBSET_LIST: SUBSET_CHANNELS.LIST,
  SUBSET_LOAD: SUBSET_CHANNELS.LOAD,
  SUBSET_DELETE: SUBSET_CHANNELS.DELETE,

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
  SWARM_GET_DELEGATE_MODE: 'swarm:get-delegate-mode',
  SWARM_APPROVE_LAUNCH: 'swarm:approve-launch',
  SWARM_REJECT_LAUNCH: 'swarm:reject-launch',
  SWARM_CANCEL_AGENT: 'swarm:cancel-agent',
  SWARM_RETRY_AGENT: 'swarm:retry-agent',
  SWARM_APPROVE_PLAN: 'swarm:approve-plan',
  SWARM_REJECT_PLAN: 'swarm:reject-plan',

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

  // Checkpoint channels (Rewind UI)
  CHECKPOINT_LIST: 'checkpoint:list',
  CHECKPOINT_REWIND: 'checkpoint:rewind',
  CHECKPOINT_PREVIEW: 'checkpoint:preview',
  CHECKPOINT_FORK: 'checkpoint:fork',

  // Suggestions channels (智能提示)
  SUGGESTIONS_GET: 'suggestions:get',

  // Context compact channels (部分压缩)
  CONTEXT_COMPACT_FROM: 'context:compact-from',

  // Context intervention channels (pin/exclude/retain)
  CONTEXT_INTERVENTION_GET: 'context:intervention:get',
  CONTEXT_INTERVENTION_SET: 'context:intervention:set',

  // Context observability channels (API true-view + token distribution)
  CONTEXT_GET_VIEW: 'context:getView',

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
  REPLAY_GET_STRUCTURED_DATA: TELEMETRY_CHANNELS.GET_STRUCTURED_REPLAY,
  TELEMETRY_EVENT: TELEMETRY_CHANNELS.EVENT,


  // VoicePaste channels (全局语音粘贴)
  VOICE_PASTE_STATUS: 'voice-paste:status',
  VOICE_PASTE_GET_STATUS: 'voice-paste:get-status',
  VOICE_PASTE_TOGGLE: 'voice-paste:toggle',

  // Provider fallback channels (错误处理)
  PROVIDER_FALLBACK: 'provider:fallback',
} as const;

/** Union type of all IPC channel string literals */
export type AllChannels = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
