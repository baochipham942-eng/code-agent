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

/** Bash 工具配置 */
export const BASH = {
  /** 默认超时 (2 分钟) */
  DEFAULT_TIMEOUT: 120000,
  /** 最大超时 (10 分钟) */
  MAX_TIMEOUT: 600000,
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
  /** EAGAIN 重试标志 — 降级为单线程 */
  EAGAIN_RETRY_THREADS: 1,
  /** -A / -B / -C 上限（防止 LLM 写出爆炸性的 context=10000） */
  MAX_CONTEXT_LINES: 10,
} as const;

/** 沙箱配置 */
export const SANDBOX = {
  /** 默认执行超时 (5 秒) */
  DEFAULT_TIMEOUT: 5000,
} as const;

/** Codex 沙箱委托配置 */
export const CODEX_SANDBOX = {
  /** 工具调用超时 (ms) */
  TIMEOUT: 30_000,
  /** 是否默认启用 */
  ENABLED_DEFAULT: false,
  /** 环境变量名（启用/禁用开关） */
  ENV_VAR: 'CODEX_SANDBOX_ENABLED',
  /** Codex MCP 服务器名称 */
  SERVER_NAME: 'codex',
} as const;

/** Codex 会话挖掘配置 */
export const CODEX_SESSION = {
  /** Codex 会话存储目录 */
  DIR: '~/.codex/sessions',
  /** 学习回溯天数 */
  LEARNING_LOOKBACK_DAYS: 7,
  /** 每次扫描的最大会话数 */
  MAX_SESSIONS_PER_SCAN: 50,
  /** 单行最大字符数（超过截断） */
  MAX_LINE_LENGTH: 500_000,
} as const;

/** 双模型交叉验证配置 */
export const CROSS_VERIFY = {
  /** 默认关闭 */
  ENABLED_DEFAULT: false,
  /** 环境变量开关 */
  ENV_VAR: 'CROSS_VERIFY_ENABLED',
  /** Codex 调用超时 (ms) */
  TIMEOUT: 60_000,
  /** 相似度阈值 — >= 此值视为 agreement */
  SIMILARITY_THRESHOLD: 0.7,
} as const;
