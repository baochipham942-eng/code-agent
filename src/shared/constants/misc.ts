/** 同步配置 */
export const SYNC = {
  /** 同步间隔 (ms) */
  SYNC_INTERVAL: 60000,
  /** 冲突检测窗口 (ms) */
  CONFLICT_WINDOW: 5000,
  /** 批量同步大小 */
  BATCH_SIZE: 50,
} as const;

/** 更新检查配置 */
export const UPDATE = {
  /** 检查间隔 (24 小时) */
  CHECK_INTERVAL: 86400000,
  /** 下载超时 (5 分钟) */
  DOWNLOAD_TIMEOUT: 300000,
  /** 启动后首次检查延迟 (5 秒) */
  INITIAL_CHECK_DELAY: 5000,
  /** 云端检查间隔 (1 小时) */
  CLOUD_CHECK_INTERVAL: 3600000,
} as const;

/** WebSocket 配置 */
export const WEBSOCKET = {
  /** 重连延迟 (1 秒) */
  RECONNECT_DELAY: 1000,
  /** 心跳间隔 (30 秒) */
  HEARTBEAT_INTERVAL: 30000,
  /** 消息超时 (30 秒) */
  MESSAGE_TIMEOUT: 30000,
  /** 最大重连次数 */
  MAX_RECONNECTS: 5,
  /** 正常关闭代码 */
  CLOSE_CODE_NORMAL: 1000,
} as const;

/** 任务同步配置 */
export const TASK_SYNC = {
  /** 同步间隔 (10 秒) */
  SYNC_INTERVAL: 10000,
  /** 重试延迟 (5 秒) */
  RETRY_DELAY: 5000,
  /** 批量大小 */
  BATCH_SIZE: 20,
  /** 重试次数 */
  RETRY_ATTEMPTS: 3,
  /** 同步任务间隔 (5 秒) - CloudTaskService */
  CLOUD_TASK_SYNC_INTERVAL: 5000,
} as const;

/** 任务分析配置 */
export const TASK_ANALYSIS = {
  /** 默认预估时长 (30 秒) */
  DEFAULT_ESTIMATED_DURATION: 30000,
  /** 最小预估时长 (10 秒) */
  MIN_ESTIMATED_DURATION: 10000,
  /** 自动拆分阈值 (词数) */
  AUTO_SPLIT_THRESHOLD: 100,
  /** 长 Prompt 乘数 */
  LONG_PROMPT_MULTIPLIER: 5,
  /** 段落最小长度 */
  MIN_PARAGRAPH_LENGTH: 20,
  /** 段落最小长度 (有效) */
  MIN_SEGMENT_LENGTH: 10,
} as const;

/** 重试间隔配置 */
export const RETRY = {
  /** 等待轮询间隔 (100ms) */
  POLL_INTERVAL: 100,
  /** 云端等待间隔 (1 秒) */
  CLOUD_WAIT_INTERVAL: 1000,
} as const;

/** 检查点配置 */
export const CHECKPOINT = {
  /** 自动保存间隔 (10 秒) */
  AUTO_SAVE_INTERVAL: 10000,
  /** 最大检查点数 */
  MAX_CHECKPOINTS: 50,
} as const;

/** 策略同步配置 */
export const STRATEGY_SYNC = {
  /** 同步间隔 (5 分钟) */
  SYNC_INTERVAL: 300000,
  /** 最小反馈数量 */
  MIN_FEEDBACK_COUNT: 100,
  /** 最大本地策略数 */
  MAX_LOCAL_STRATEGIES: 50,
} as const;

/** 网络端口配置 */
export const PORTS = {
  /** Log Bridge 默认端口 */
  logBridge: typeof process !== 'undefined' && process.env?.LOG_BRIDGE_PORT
    ? parseInt(process.env.LOG_BRIDGE_PORT, 10)
    : 51820,
} as const;

/** macOS 原生连接器 id（仅枚举可用值，默认不自动启用）*/
export const NATIVE_CONNECTOR_IDS = ['calendar', 'mail', 'reminders'] as const;
export type NativeConnectorId = typeof NATIVE_CONNECTOR_IDS[number];
