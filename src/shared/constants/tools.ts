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
  /** shell 进程 exit 后等待 stdio 'close'（管道 EOF）的兜底窗口；
   *  超过则用 exit 结果 settle，防止被命令后台化、持有 stdout 管道的子进程让 'close' 永不触发 */
  POST_EXIT_DRAIN_MS: 150,
  /** 超时/abort 先发 SIGTERM，宽限此时长后整组仍未退出则升级 SIGKILL */
  KILL_GRACE_MS: 2000,
  /** rtk rewrite 子进程超时（fail-closed 退回原命令） */
  RTK_REWRITE_TIMEOUT: 500,
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

/**
 * 工具结果落盘配置 (GAP-009)
 *
 * 截断 = 信息永久丢失，agent 想再看只能重跑命令；
 * 落盘 = 上下文留摘要+路径，agent 可用 Read/Grep 回查。
 */
export const TOOL_RESULT_SPILL = {
  /** ~/.code-agent/ 下的临时目录名 */
  TMP_DIR: 'tmp',
  /** session 临时目录下的工具结果子目录名 */
  SUBDIR: 'tool-results',
  /** 无 session 上下文时的目录名 */
  SHARED_SESSION: 'shared',
  /** 单文件最大落盘字节数（10MB，防止异常超大输出写爆磁盘） */
  MAX_SPILL_BYTES: 10 * 1024 * 1024,
  /** 落盘文件名单段最大字符数，避免结构化调用 ID 超出文件系统单段限制 */
  MAX_FILENAME_SEGMENT: 48,
  /**
   * 落盘提示的标识前缀。
   * 同时用于：防重复落盘（toolResultSpill）+ 压缩豁免（tokenOptimizer 提取后拼回，
   * 否则 compressToolResult 的尾部预算 ~30 token 会把带长路径的提示行整体吞掉）。
   */
  NOTICE_MARKER: '[Full output saved to:',
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

/**
 * 启动时探测的本地 CLI 候选清单。
 *
 * 探针并行跑 `which X`，检测命中的 CLI 暴露给模型（写入 system prompt 的
 * <env-capabilities> 块）。设计原则：
 * - 只暴露探到的（缺失就不出现），新装 CLI 重启即生效
 * - 不点名"小红书用 opencli" 这类硬规则，给清单 + discovery 原则
 * - 新增 CLI 在这里加一行，不改代码
 */
export const PROBED_CLI_CANDIDATES: readonly string[] = [
  // 数据处理 / 文本
  'jq', 'yq', 'rg', 'fd', 'sqlite3',
  // 网页抓取 / 反爬
  'opencli', 'jina',
  // 文档 / OCR
  'mineru', 'pdftotext', 'pandoc',
  // 媒体
  'ffmpeg', 'imagemagick',
  // 网络
  'curl', 'wget', 'http',
  // VCS / 包管理（部分系统不带）
  'gh', 'hub',
] as const;

/** 探针超时（每个 which 调用），避免启动卡死 */
export const ENV_PROBE_TIMEOUT_MS = 1500;
