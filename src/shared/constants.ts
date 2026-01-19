/**
 * 全局常量定义
 * 消除魔法数字，集中管理配置值
 */

/** Agent 配置 */
export const AGENT = {
  /** 最大迭代次数 */
  MAX_ITERATIONS: 30,
  /** 最大重试次数 */
  MAX_RETRIES: 3,
  /** 默认超时时间 (ms) */
  DEFAULT_TIMEOUT: 60000,
  /** 最大消息长度 */
  MAX_MESSAGE_LENGTH: 100000,
  /** 子任务最大深度 */
  MAX_SUBTASK_DEPTH: 5,
} as const;

/** 缓存配置 */
export const CACHE = {
  /** 配置缓存 TTL (1 小时) */
  CONFIG_TTL: 3600000,
  /** Token 缓存 TTL (24 小时) */
  TOKEN_TTL: 86400000,
  /** Session 缓存 TTL (7 天) */
  SESSION_TTL: 604800000,
  /** Prompt 缓存 TTL (1 小时) */
  PROMPT_TTL: 3600000,
} as const;

/** 文件配置 */
export const FILE = {
  /** 最大文件大小 (10MB) */
  MAX_SIZE: 10 * 1024 * 1024,
  /** 最大行数 */
  MAX_LINES: 10000,
  /** 默认编码 */
  ENCODING: 'utf-8' as const,
  /** 最大读取字符数 */
  MAX_READ_CHARS: 100000,
} as const;

/** UI 配置 */
export const UI = {
  /** 防抖延迟 (ms) */
  DEBOUNCE_DELAY: 300,
  /** 动画时长 (ms) */
  ANIMATION_DURATION: 200,
  /** 历史记录最大条数 */
  MAX_HISTORY_ITEMS: 100,
  /** Toast 默认显示时长 (ms) */
  TOAST_DURATION: 5000,
  /** 复制成功反馈时长 (ms) */
  COPY_FEEDBACK_DURATION: 2000,
  /** 侧边栏默认宽度 */
  SIDEBAR_WIDTH: 280,
  /** 启动延迟-更新检查 (ms) */
  STARTUP_UPDATE_CHECK_DELAY: 2000,
  /** 启动延迟-API Key 检查 (ms) */
  STARTUP_API_KEY_CHECK_DELAY: 1500,
  /** 面板刷新间隔 (ms) */
  PANEL_REFRESH_INTERVAL: 30000,
  /** 云任务刷新间隔 (ms) */
  CLOUD_TASK_REFRESH_INTERVAL: 5000,
  /** 预览文本截断长度 */
  PREVIEW_TEXT_MAX_LENGTH: 500,
  /** 最大附件数量（文件选择） */
  MAX_ATTACHMENTS_FILE_SELECT: 5,
  /** 最大附件数量（拖放） */
  MAX_ATTACHMENTS_DROP: 10,
  /** 文本域最大高度 (px) */
  TEXTAREA_MAX_HEIGHT: 200,
} as const;

/** 网络配置 */
export const NETWORK = {
  /** API 请求超时 (ms) */
  API_TIMEOUT: 30000,
  /** 重试延迟 (ms) */
  RETRY_DELAY: 1000,
  /** 最大并发请求数 */
  MAX_CONCURRENT: 5,
  /** WebSocket 重连延迟 (ms) */
  WS_RECONNECT_DELAY: 3000,
  /** 健康检查间隔 (ms) */
  HEALTH_CHECK_INTERVAL: 30000,
} as const;

/** MCP 配置 */
export const MCP = {
  /** 连接超时 (ms) */
  CONNECT_TIMEOUT: 10000,
  /** Ping 间隔 (ms) */
  PING_INTERVAL: 30000,
  /** 最大重连次数 */
  MAX_RECONNECTS: 3,
  /** 请求超时 (ms) */
  REQUEST_TIMEOUT: 30000,
} as const;

/** 模型配置 */
export const MODEL = {
  /** 默认 max_tokens */
  DEFAULT_MAX_TOKENS: 8192,
  /** 默认 temperature */
  DEFAULT_TEMPERATURE: 0.7,
  /** 流式响应块大小 */
  STREAM_CHUNK_SIZE: 1024,
  /** 上下文窗口安全边际 */
  CONTEXT_SAFETY_MARGIN: 1000,
} as const;

/** 同步配置 */
export const SYNC = {
  /** 同步间隔 (ms) */
  SYNC_INTERVAL: 60000,
  /** 冲突检测窗口 (ms) */
  CONFLICT_WINDOW: 5000,
  /** 批量同步大小 */
  BATCH_SIZE: 50,
} as const;

/** 内存/向量配置 */
export const MEMORY = {
  /** 默认相似度阈值 */
  SIMILARITY_THRESHOLD: 0.7,
  /** 最大返回结果数 */
  MAX_RESULTS: 10,
  /** 嵌入维度 */
  EMBEDDING_DIMENSION: 1536,
  /** 索引刷新间隔 (ms) */
  INDEX_REFRESH_INTERVAL: 300000,
} as const;

/** 规划配置 */
export const PLANNING = {
  /** 最大 TODO 数量 */
  MAX_TODOS: 50,
  /** 最大 Findings 数量 */
  MAX_FINDINGS: 100,
  /** 计划文件最大大小 */
  MAX_PLAN_SIZE: 50000,
} as const;

/** 窗口配置 */
export const WINDOW = {
  /** 默认宽度 */
  DEFAULT_WIDTH: 1200,
  /** 默认高度 */
  DEFAULT_HEIGHT: 800,
  /** 最小宽度 */
  MIN_WIDTH: 800,
  /** 最小高度 */
  MIN_HEIGHT: 600,
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

/** 云端配置 */
export const CLOUD = {
  /** 默认超时 (30 秒) */
  DEFAULT_TIMEOUT: 30000,
  /** 长任务超时 (5 分钟) */
  LONG_TASK_TIMEOUT: 300000,
  /** Warmup 超时 (10 秒) */
  WARMUP_TIMEOUT: 10000,
  /** Warmup 间隔 (5 分钟) */
  WARMUP_INTERVAL: 300000,
  /** Fetch 超时 (5 秒) */
  FETCH_TIMEOUT: 5000,
  /** 云端执行超时 (2 分钟) */
  CLOUD_EXECUTION_TIMEOUT: 120000,
  /** 本地执行超时 (1 分钟) */
  LOCAL_EXECUTION_TIMEOUT: 60000,
  /** 云端搜索超时 (3 秒) */
  CLOUD_SEARCH_TIMEOUT: 3000,
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

/** Bash 工具配置 */
export const BASH = {
  /** 默认超时 (2 分钟) */
  DEFAULT_TIMEOUT: 120000,
  /** 最大输出长度 */
  MAX_OUTPUT_LENGTH: 30000,
  /** 最大缓冲区大小 (10MB) */
  MAX_BUFFER: 10 * 1024 * 1024,
} as const;

/** Grep 工具配置 */
export const GREP = {
  /** 默认超时 (30 秒) */
  DEFAULT_TIMEOUT: 30000,
  /** 最大匹配行长度 */
  MAX_LINE_LENGTH: 500,
  /** 单文件最大匹配数 */
  MAX_MATCHES_PER_FILE: 100,
  /** 总最大匹配数 */
  MAX_TOTAL_MATCHES: 200,
} as const;

/** Agent 超时配置 (按角色) */
export const AGENT_TIMEOUT = {
  PLANNER: 60000,
  RESEARCHER: 120000,
  CODER: 180000,
  REVIEWER: 90000,
  WRITER: 120000,
  TESTER: 180000,
  COORDINATOR: 300000,
} as const;

/** Agent 迭代配置 (按角色) */
export const AGENT_ITERATIONS = {
  PLANNER: 15,
  RESEARCHER: 20,
  CODER: 30,
  REVIEWER: 20,
  WRITER: 25,
  TESTER: 25,
  COORDINATOR: 50,
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

/** 工具缓存配置 */
export const TOOL_CACHE = {
  /** 默认 TTL (5 分钟) */
  DEFAULT_TTL: 300000,
  /** 读取文件 TTL (5 分钟) */
  READ_FILE_TTL: 300000,
  /** 目录列表 TTL (2 分钟) */
  LIST_DIRECTORY_TTL: 120000,
  /** Glob TTL (2 分钟) */
  GLOB_TTL: 120000,
  /** Grep TTL (2 分钟) */
  GREP_TTL: 120000,
  /** Web Fetch TTL (15 分钟) */
  WEB_FETCH_TTL: 900000,
} as const;

/** 检查点配置 */
export const CHECKPOINT = {
  /** 自动保存间隔 (10 秒) */
  AUTO_SAVE_INTERVAL: 10000,
  /** 最大检查点数 */
  MAX_CHECKPOINTS: 50,
} as const;

/** 历史记录配置 */
export const HISTORY = {
  /** 使用记录最大条数 */
  MAX_USAGE_HISTORY: 1000,
  /** Token 记录最大条数 */
  MAX_TOKEN_HISTORY: 1000,
} as const;

/** 沙箱配置 */
export const SANDBOX = {
  /** 默认执行超时 (5 秒) */
  DEFAULT_TIMEOUT: 5000,
} as const;

/** 向量存储配置 */
export const VECTOR_STORE = {
  /** 最大文档数 */
  MAX_DOCUMENTS: 10000,
  /** 默认 TopK */
  DEFAULT_TOP_K: 10,
  /** 默认相似度阈值 */
  DEFAULT_THRESHOLD: 0.7,
  /** 分块大小 */
  CHUNK_SIZE: 1000,
  /** 分块重叠 */
  CHUNK_OVERLAP: 100,
} as const;

/** Embedding 服务配置 */
export const EMBEDDING = {
  /** 最大缓存大小 */
  MAX_CACHE_SIZE: 10000,
  /** 批量处理大小 */
  BATCH_SIZE: 100,
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
