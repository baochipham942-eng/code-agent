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
} as const;

/**
 * Evaluation 通道名称类型
 */
export type EvaluationChannel = (typeof EVALUATION_CHANNELS)[keyof typeof EVALUATION_CHANNELS];
