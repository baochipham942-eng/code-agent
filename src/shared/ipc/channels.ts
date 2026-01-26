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
