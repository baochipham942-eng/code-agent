// ============================================================================
// IPC Channels - Skill 管理系统通道定义
// ============================================================================

/**
 * Skill 管理系统 IPC 通道
 * 用于前端与主进程之间的 Skill 仓库管理通信
 */
export const SKILL_CHANNELS = {
  // ------------------------------------------------------------------------
  // 仓库管理
  // ------------------------------------------------------------------------

  /** 获取已下载仓库列表 */
  REPO_LIST: 'skill:repo:list',
  /** 下载仓库 */
  REPO_DOWNLOAD: 'skill:repo:download',
  /** 更新仓库 */
  REPO_UPDATE: 'skill:repo:update',
  /** 删除仓库 */
  REPO_REMOVE: 'skill:repo:remove',
  /** 添加自定义仓库 */
  REPO_ADD_CUSTOM: 'skill:repo:add-custom',

  // ------------------------------------------------------------------------
  // Skill 管理
  // ------------------------------------------------------------------------

  /** 获取所有可用 skills */
  SKILL_LIST: 'skill:list',
  /** 全局启用 skill */
  SKILL_ENABLE: 'skill:enable',
  /** 全局禁用 skill */
  SKILL_DISABLE: 'skill:disable',

  // ------------------------------------------------------------------------
  // 会话挂载
  // ------------------------------------------------------------------------

  /** 挂载到会话 */
  SESSION_MOUNT: 'skill:session:mount',
  /** 从会话卸载 */
  SESSION_UNMOUNT: 'skill:session:unmount',
  /** 获取会话挂载列表 */
  SESSION_LIST: 'skill:session:list',
  /** 获取推荐 */
  SESSION_RECOMMEND: 'skill:session:recommend',

  // ------------------------------------------------------------------------
  // 推荐仓库
  // ------------------------------------------------------------------------

  /** 获取推荐仓库列表 */
  RECOMMENDED_REPOS: 'skill:recommended-repos',

  // ------------------------------------------------------------------------
  // SkillsMP 搜索
  // ------------------------------------------------------------------------

  /** 搜索 SkillsMP 社区 Skills */
  SKILLSMP_SEARCH: 'skill:skillsmp:search',

  // ------------------------------------------------------------------------
  // Combo Skills 录制
  // ------------------------------------------------------------------------

  /** 开始录制 */
  COMBO_START: 'skill:combo:start',
  /** 停止录制 */
  COMBO_STOP: 'skill:combo:stop',
  /** 标记新一轮（用户消息） */
  COMBO_MARK_TURN: 'skill:combo:mark-turn',
  /** 检查是否有建议 */
  COMBO_CHECK_SUGGESTION: 'skill:combo:check-suggestion',
  /** 保存为 Skill */
  COMBO_SAVE: 'skill:combo:save',
  /** 获取录制数据 */
  COMBO_GET_RECORDING: 'skill:combo:get-recording',
} as const;

/**
 * Skill 通道名称类型
 */
export type SkillChannel = (typeof SKILL_CHANNELS)[keyof typeof SKILL_CHANNELS];

// ============================================================================
// DAG 可视化系统 IPC 通道
// ============================================================================

/**
 * DAG 可视化 IPC 通道
 * 用于前端订阅 DAG 执行状态更新
 */
export const DAG_CHANNELS = {
  /** DAG 事件推送（主进程 -> 渲染进程） */
  EVENT: 'dag:event',
  /** DAG 状态初始化 */
  INIT: 'dag:init',
  /** DAG 任务状态更新 */
  TASK_STATUS: 'dag:task:status',
  /** DAG 任务进度更新 */
  TASK_PROGRESS: 'dag:task:progress',
  /** DAG 统计信息更新 */
  STATISTICS: 'dag:statistics',
} as const;

/**
 * DAG 通道名称类型
 */
export type DAGChannel = (typeof DAG_CHANNELS)[keyof typeof DAG_CHANNELS];

// ============================================================================
// Lab 实验室系统 IPC 通道
// ============================================================================

/**
 * Lab 实验室 IPC 通道
 * 用于前端与主进程之间的模型训练实验室通信
 */
export const LAB_CHANNELS = {
  /** 下载项目仓库 */
  DOWNLOAD_PROJECT: 'lab:download-project',
  /** 上传自定义数据集 */
  UPLOAD_DATA: 'lab:upload-data',
  /** 开始训练 */
  START_TRAINING: 'lab:start-training',
  /** 停止训练 */
  STOP_TRAINING: 'lab:stop-training',
  /** 推理测试 */
  INFERENCE: 'lab:inference',
  /** 训练进度事件 */
  TRAINING_PROGRESS: 'lab:training-progress',
  /** 获取项目状态 */
  GET_PROJECT_STATUS: 'lab:get-project-status',
  /** 检查 Python 环境 */
  CHECK_PYTHON_ENV: 'lab:check-python-env',
} as const;

/**
 * Lab 通道名称类型
 */
export type LABChannel = (typeof LAB_CHANNELS)[keyof typeof LAB_CHANNELS];

// ============================================================================
// Channel 多通道接入系统 IPC 通道
// ============================================================================

/**
 * Channel 多通道接入 IPC 通道
 * 用于前端与主进程之间的多通道管理通信
 */
export const CHANNEL_CHANNELS = {
  /** 获取所有账号 */
  LIST_ACCOUNTS: 'channel:list-accounts',
  /** 添加账号 */
  ADD_ACCOUNT: 'channel:add-account',
  /** 更新账号 */
  UPDATE_ACCOUNT: 'channel:update-account',
  /** 删除账号 */
  DELETE_ACCOUNT: 'channel:delete-account',
  /** 连接账号 */
  CONNECT_ACCOUNT: 'channel:connect-account',
  /** 断开账号 */
  DISCONNECT_ACCOUNT: 'channel:disconnect-account',
  /** 获取可用通道类型 */
  GET_CHANNEL_TYPES: 'channel:get-types',
  /** 账号状态变化事件 */
  ACCOUNT_STATUS_CHANGED: 'channel:account-status-changed',
  /** 账号列表变化事件 */
  ACCOUNTS_CHANGED: 'channel:accounts-changed',
} as const;

/**
 * Channel 通道名称类型
 */
export type ChannelChannel = (typeof CHANNEL_CHANNELS)[keyof typeof CHANNEL_CHANNELS];

// ============================================================================
// Evaluation 评测系统 IPC 通道
// ============================================================================

/**
 * Evaluation 评测系统 IPC 通道
 * 用于前端与主进程之间的会话评测通信
 */
export const EVALUATION_CHANNELS = {
  /** 执行评测 */
  RUN: 'evaluation:run',
  /** 获取评测结果 */
  GET_RESULT: 'evaluation:get-result',
  /** 获取评测历史列表 */
  LIST_HISTORY: 'evaluation:list-history',
  /** 导出评测报告 */
  EXPORT: 'evaluation:export',
  /** 删除评测记录 */
  DELETE: 'evaluation:delete',

  // ------------------------------------------------------------------------
  // 会话分析（v2 - 分离客观指标和主观评测）
  // ------------------------------------------------------------------------

  /** 获取会话客观指标（不需要 LLM，立即返回） */
  GET_OBJECTIVE_METRICS: 'evaluation:get-objective-metrics',
  /** 获取完整会话分析（客观指标 + 历史评测） */
  GET_SESSION_ANALYSIS: 'evaluation:get-session-analysis',
  /** 执行 LLM 主观评测（按需调用） */
  RUN_SUBJECTIVE_EVALUATION: 'evaluation:run-subjective',
  /** 列出所有测试报告 */
  LIST_TEST_REPORTS: 'evaluation:list-test-reports',
  /** 加载指定测试报告 */
  LOAD_TEST_REPORT: 'evaluation:load-test-report',
  /** 保存开放编码标注 */
  SAVE_ANNOTATIONS: 'evaluation:save-annotations',
  /** 获取轴心编码聚合数据 */
  GET_AXIAL_CODING: 'evaluation:get-axial-coding',

  // Eval framework channels
  LIST_EXPERIMENTS: 'evaluation:list-experiments',
  LOAD_EXPERIMENT: 'evaluation:load-experiment',
  LIST_TEST_CASES: 'evaluation:list-test-cases',
  GET_SCORING_CONFIG: 'evaluation:get-scoring-config',
  UPDATE_SCORING_CONFIG: 'evaluation:update-scoring-config',
  GET_FAILURE_FUNNEL: 'evaluation:get-failure-funnel',
  GET_CROSS_EXPERIMENT: 'evaluation:get-cross-experiment',
  GET_GIT_COMMIT: 'evaluation:get-git-commit',
  CREATE_EXPERIMENT: 'evaluation:create-experiment',

  // Snapshot + Case Detail (Phase 1+3)
  GET_SNAPSHOT: 'evaluation:get-snapshot',
  BUILD_SNAPSHOT: 'evaluation:build-snapshot',
  GET_CASE_DETAIL: 'evaluation:get-case-detail',

  // Phase 6.2 + minimal 6.3: review queue / failure follow-up sink
  REVIEW_QUEUE_LIST: 'evaluation:review-queue:list',
  REVIEW_QUEUE_ENQUEUE: 'evaluation:review-queue:enqueue',
  REVIEW_QUEUE_UPDATE_FAILURE_ASSET: 'evaluation:review-queue:update-failure-asset',
} as const;

/**
 * Evaluation 通道名称类型
 */
export type EvaluationChannel = (typeof EVALUATION_CHANNELS)[keyof typeof EVALUATION_CHANNELS];

// ============================================================================
// LSP 语言服务器 IPC 通道
// ============================================================================

/**
 * LSP 语言服务器 IPC 通道
 * 用于前端与主进程之间的 LSP 状态查询
 */
export const LSP_CHANNELS = {
  /** 获取 LSP 状态 */
  GET_STATUS: 'lsp:get-status',
  /** 检查语言服务器安装状态 */
  CHECK_SERVERS: 'lsp:check-servers',
  /** 手动初始化 LSP */
  INITIALIZE: 'lsp:initialize',
} as const;

/**
 * LSP 通道名称类型
 */
export type LSPChannel = (typeof LSP_CHANNELS)[keyof typeof LSP_CHANNELS];

// ============================================================================
// Background 后台任务 IPC 通道
// ============================================================================

/**
 * Background 后台任务 IPC 通道
 * 用于前端与主进程之间的后台任务管理
 */
export const BACKGROUND_CHANNELS = {
  /** 将会话移至后台 */
  MOVE_TO_BACKGROUND: 'background:move-to-background',
  /** 将会话恢复到前台 */
  MOVE_TO_FOREGROUND: 'background:move-to-foreground',
  /** 获取所有后台任务 */
  GET_TASKS: 'background:get-tasks',
  /** 获取后台任务数量 */
  GET_COUNT: 'background:get-count',
  /** 后台任务更新事件 */
  TASK_UPDATE: 'background:task:update',
} as const;

/**
 * Background 通道名称类型
 */
export type BackgroundChannel = (typeof BACKGROUND_CHANNELS)[keyof typeof BACKGROUND_CHANNELS];

// ============================================================================
// Telemetry 遥测系统 IPC 通道
// ============================================================================

/**
 * Telemetry 遥测系统 IPC 通道
 * 用于前端与主进程之间的会话遥测数据通信
 */
export const TELEMETRY_CHANNELS = {
  /** 获取会话遥测详情 */
  GET_SESSION: 'telemetry:get-session',
  /** 获取会话遥测列表 */
  LIST_SESSIONS: 'telemetry:list-sessions',
  /** 获取轮次列表 */
  GET_TURNS: 'telemetry:get-turns',
  /** 获取轮次详情（含 model calls, tool calls, events） */
  GET_TURN_DETAIL: 'telemetry:get-turn-detail',
  /** 获取工具使用统计 */
  GET_TOOL_STATS: 'telemetry:get-tool-stats',
  /** 获取意图分布统计 */
  GET_INTENT_DIST: 'telemetry:get-intent-dist',
  /** 获取会话所有事件（用于时间线） */
  GET_EVENTS: 'telemetry:get-events',
  /** 获取系统提示词（按 hash） */
  GET_SYSTEM_PROMPT: 'telemetry:get-system-prompt',
  /** 删除会话遥测数据 */
  DELETE_SESSION: 'telemetry:delete-session',
  /** 获取结构化回放数据 */
  GET_STRUCTURED_REPLAY: 'replay:get-structured-data',
  /** 实时事件推送（主进程 -> 渲染进程） */
  EVENT: 'telemetry:event',
} as const;

/**
 * Telemetry 通道名称类型
 */
export type TelemetryChannel = (typeof TELEMETRY_CHANNELS)[keyof typeof TELEMETRY_CHANNELS];

// ============================================================================
// Test Subset 数据集子集管理 IPC 通道
// ============================================================================

/**
 * Test Subset IPC 通道
 * 用于前端与主进程之间的测试子集管理
 */
export const SUBSET_CHANNELS = {
  /** 保存测试子集 */
  SAVE: 'evaluation:save-test-subset',
  /** 获取所有已保存的子集列表 */
  LIST: 'evaluation:list-test-subsets',
  /** 加载指定子集 */
  LOAD: 'evaluation:load-test-subset',
  /** 删除指定子集 */
  DELETE: 'evaluation:delete-test-subset',
} as const;

/**
 * Subset 通道名称类型
 */
export type SubsetChannel = (typeof SUBSET_CHANNELS)[keyof typeof SUBSET_CHANNELS];
