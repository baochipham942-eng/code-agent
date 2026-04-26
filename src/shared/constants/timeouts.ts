/** MCP 连接超时配置 */
export const MCP_TIMEOUTS = {
  /** SSE 连接超时 */
  SSE_CONNECT: 30_000,
  /** stdio 连接超时 */
  STDIO_CONNECT: 120_000,
  /** 首次运行超时（需要安装依赖等） */
  FIRST_RUN: 180_000,
  /** 工具调用重试超时 */
  TOOL_RETRY: 30_000,
} as const;

/** DAG 调度器配置 */
export const DAG_SCHEDULER = {
  /** 默认超时 */
  DEFAULT_TIMEOUT: 120_000,
  /** 默认并行度 */
  DEFAULT_PARALLELISM: 4,
  /** 调度间隔 */
  SCHEDULE_INTERVAL: 100,
  /** 默认最大重试次数（显式配置重试，默认不重试） */
  DEFAULT_MAX_RETRIES: 0,
} as const;

/** 编排器超时配置 */
export const ORCHESTRATOR_TIMEOUTS = {
  /** 本地执行超时 */
  LOCAL_EXECUTOR: 120_000,
  /** 云端执行超时 */
  CLOUD_EXECUTOR: 180_000,
  /** Agent 委托超时 */
  AGENT_DELEGATION: 60_000,
  /** Agent 执行器超时 */
  AGENT_EXECUTOR: 180_000,
  /** 统一编排器默认超时 */
  UNIFIED_DEFAULT: 120_000,
  /** 统一编排器扩展超时 */
  UNIFIED_EXTENDED: 180_000,
} as const;

/** 服务初始化超时 */
export const SERVICE_TIMEOUTS = {
  /** MCP 连接 */
  MCP_CONNECT: 60_000,
  /** 容器初始化 */
  CONTAINER_INIT: 30_000,
  /** 生命周期操作 */
  LIFECYCLE: 30_000,
  /** 引导程序 */
  BOOTSTRAP: 30_000,
} as const;

/** 用户交互超时 */
export const INTERACTION_TIMEOUTS = {
  /** 用户问题等待超时 */
  USER_QUESTION: 300_000,
  /** 确认操作超时 */
  CONFIRM_ACTION: 60_000,
  /** 权限请求超时 */
  PERMISSION: 60_000,
  /** MCP Elicitation 用户输入超时 */
  MCP_ELICITATION: 60_000,
} as const;

/** 锁和资源管理超时 */
export const LOCK_TIMEOUTS = {
  /** 锁默认超时 */
  DEFAULT: 300_000,
  /** 锁清理间隔 */
  CLEANUP_INTERVAL: 30_000,
  /** Agent Bus 超时 */
  AGENT_BUS: 300_000,
  /** Agent Bus 清理间隔 */
  AGENT_BUS_CLEANUP: 30_000,
} as const;

/** 性能阈值（毫秒） */
export const PERFORMANCE_THRESHOLDS = {
  /** 快速响应阈值 */
  FAST_RESPONSE: 60_000,
  /** 慢响应阈值 */
  SLOW_RESPONSE: 120_000,
  /** 策略优化阈值 */
  STRATEGY_OPTIMIZATION: 300_000,
  /** 模型请求超时 */
  MODEL_REQUEST: 300_000,
  /** 任务队列超时 */
  TASK_QUEUE: 300_000,
  /** 网络重试最大延迟 */
  NETWORK_RETRY_MAX_DELAY: 30_000,
} as const;

/** 数据源路由超时配置 */
export const DATA_SOURCE_TIMEOUTS = {
  /** Web 搜索 */
  WEB_SEARCH: 20_000,
  /** Web 爬取 */
  WEB_CRAWL: 30_000,
  /** 深度搜索 */
  DEEP_SEARCH: 45_000,
  /** 代码搜索 */
  CODE_SEARCH: 15_000,
  /** 文件搜索 */
  FILE_SEARCH: 15_000,
  /** 学术搜索 */
  ACADEMIC_SEARCH: 15_000,
  /** 新闻搜索 */
  NEWS_SEARCH: 20_000,
  /** 图片搜索 */
  IMAGE_SEARCH: 15_000,
  /** 视频搜索 */
  VIDEO_SEARCH: 30_000,
  /** 社交搜索 */
  SOCIAL_SEARCH: 10_000,
  /** 快速验证 */
  QUICK_VALIDATION: 5_000,
  /** 默认搜索 */
  DEFAULT: 15_000,
} as const;

/** 沙箱执行超时 */
export const SANDBOX_TIMEOUTS = {
  /** 默认执行超时 */
  DEFAULT: 120_000,
  /** 命令检测超时 */
  COMMAND_CHECK: 5_000,
  /** 路径检测超时 */
  PATH_CHECK: 1_000,
  /** 脚本执行超时 */
  SCRIPT_EXECUTION: 5_000,
  /** 工具验证超时 */
  TOOL_VALIDATION: 5_000,
  /** 工具测试超时 */
  TOOL_TEST: 30_000,
} as const;

/** Hook 超时配置 */
export const HOOK_TIMEOUTS = {
  /** 脚本执行默认超时 */
  SCRIPT_DEFAULT: 5_000,
  /** Prompt Hook AI 评估超时 */
  AI_EVALUATION: 10_000,
  /** 观察者超时 */
  OBSERVER: 5_000,
  /** 决策超时 */
  DECISION: 10_000,
} as const;

/** 网络工具超时 */
export const NETWORK_TOOL_TIMEOUTS = {
  /** HTTP 请求默认超时 */
  HTTP_DEFAULT: 30_000,
  /** HTTP 请求最大超时 */
  HTTP_MAX: 300_000,
  /** 图片分析超时 */
  IMAGE_ANALYZE: 30_000,
  /** 图片标注超时 */
  IMAGE_ANNOTATE: 60_000,
  /** 截图超时 */
  SCREENSHOT: 30_000,
  /** 语音转文本超时 */
  SPEECH_TO_TEXT: 60_000,
  /** 文本转语音超时 */
  TEXT_TO_SPEECH: 60_000,
  /** Git 克隆超时 */
  GIT_CLONE: 120_000,
  /** Git 操作超时 */
  GIT_OPERATION: 30_000,
} as const;

/** 浏览器操作超时 */
export const BROWSER_TIMEOUTS = {
  /** 浏览器操作默认超时 */
  ACTION_DEFAULT: 30_000,
  /** 等待选择器超时 */
  WAIT_SELECTOR: 5_000,
  /** 等待超时 */
  WAIT_DEFAULT: 1_000,
  /** Computer Use 等待超时 */
  COMPUTER_USE_WAIT: 5_000,
} as const;

/** 内存服务超时 */
export const MEMORY_TIMEOUTS = {
  /** 云搜索超时 */
  CLOUD_SEARCH: 3_000,
  /** LLM 摘要超时 */
  LLM_SUMMARIZE: 30_000,
  /** 触发器超时 */
  TRIGGER: 5_000,
} as const;

/** 测试运行器超时 */
export const TEST_TIMEOUTS = {
  /** 默认测试超时 */
  DEFAULT: 60_000,
} as const;

/** 资源锁超时 */
export const RESOURCE_LOCK_TIMEOUTS = {
  /** 锁获取超时 */
  ACQUIRE: 300_000,
  /** 等待超时 */
  WAIT: 30_000,
} as const;

/** 认证服务超时 */
export const AUTH_TIMEOUTS = {
  /** 会话获取超时 */
  SESSION_FETCH: 5_000,
  /** 配置文件获取超时 */
  PROFILE_FETCH: 5_000,
} as const;

/** 状态检查超时 */
export const STATUS_TIMEOUTS = {
  /** API 健康检查超时 */
  API_HEALTH_CHECK: 5_000,
} as const;

/** 任务输出超时 */
export const TASK_OUTPUT_TIMEOUTS = {
  /** 默认超时 */
  DEFAULT: 30_000,
} as const;

/** 后台任务超时 */
export const BACKGROUND_TASK_TIMEOUTS = {
  /** 默认超时 */
  DEFAULT: 30_000,
} as const;

/** Skill 服务超时 */
export const SKILL_TIMEOUTS = {
  /** 安装超时 */
  INSTALL: 30_000,
} as const;

/** Live Preview dev server 管理超时 */
export const LIVE_PREVIEW_TIMEOUTS = {
  /** dev server 启动到 ready 的最长等待时间 */
  STARTUP: 30_000,
  /** SIGTERM 后等待进程退出，超时升级 SIGKILL */
  STOP_GRACEFUL: 5_000,
  /** ready 信号探测到 URL 后再 ping 一次确认可达 */
  PING: 3_000,
} as const;

/** 工具执行进度报告配置 */
export const TOOL_PROGRESS = {
  /** 进度报告间隔 (ms) */
  REPORT_INTERVAL: 5_000,
  /** 默认超时警告阈值 (ms) */
  DEFAULT_THRESHOLD: 90_000,
} as const;

/** 工具执行超时警告阈值 (ms)，按工具名或前缀匹配 */
export const TOOL_TIMEOUT_THRESHOLDS: Record<string, number> = {
  bash: 120_000,            // 2 min（命令可能耗时较长）
  ppt_generate: 180_000,    // 3 min（多步管道）
  image_generate: 90_000,   // 1.5 min
  video_generate: 600_000,  // 10 min（视频生成较慢）
  web_fetch: 30_000,        // 30s
  web_search: 30_000,       // 30s
  read_pdf: 60_000,         // 1 min
  read_xlsx: 30_000,        // 30s
  task: 300_000,            // 5 min（子代理任务）
  spawn_agent: 300_000,     // 5 min（子代理）
  mcp: 60_000,              // 1 min
} as const;
