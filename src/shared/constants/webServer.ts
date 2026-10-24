/** web SSE 防滥用（WP3-4）：per-token 并发连接上限（长连接不受滑动窗口 rateLimit 约束，须单独设并发闸） */
export const WEB_SSE = {
  /** /api/run 每 token 最大并发 SSE 流（对齐 spawnGuard maxAgents=8 的并行会话上限） */
  MAX_CONCURRENT_PER_TOKEN: 8,
} as const;

export const WEB_SERVER_DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: 8180,
  HEALTH_PATH: '/api/health',
  /** 鉴权版健康详情（pid/serverRoot/handlers/persistence 等诊断字段只在这里） */
  HEALTH_DETAIL_PATH: '/api/health/detail',
  WORKSPACE_FILE_PATH: '/api/workspace/file',
  DEV_AUTH_TOKEN_FILE: '.dev-token',
} as const;

export const WEB_SERVER_SERVICE = {
  MODE_ENV: 'CODE_AGENT_SERVICE_MODE',
  AUTH_TOKEN_ENV: 'CODE_AGENT_WEB_AUTH_TOKEN',
} as const;

/**
 * ADR-083 常驻宿主（daemon）排空与停止参数。宽限语义：优雅停时先等在跑的 run
 * 自然收口，超时才强停（强停后的恢复走 ADR-075 的 crash_or_quit sweep，不照抄
 * 竞品「崩溃不自动恢复」口径）。
 */
export const WEB_DAEMON = {
  /**
   * 空/截断 pid 文件被视为「实例刚创建文件、尚未写完记录」的宽限（ms）。
   * 超过这段时间仍不可读即可按崩溃残留接管，避免半写文件永久阻塞启动。
   */
  UNREADABLE_PID_GRACE_MS: 2_000,
  /** 优雅停排空宽限（ms）。60s 对齐竞品默认（per ADR-083 ticket text, not re-verified）。 */
  DRAIN_GRACE_MS: 60_000,
  /**
   * 壳的 SIGKILL 看门狗还挂着（被 Tauri spawn 且 stdin 管道未断）时的排空宽限（ms）。
   * 必须留在这段预算内：Rust 侧 GRACEFUL_SHUTDOWN_TIMEOUT 只有 3s，到点 SIGKILL，
   * 关库（唯一不能跳过的一步）会被吃穿 → 陈旧 -wal/-shm 老坑。与
   * WEB_SERVER_SHUTDOWN_TIMEOUTS.PRE_DB_BUDGET_MS（2s）同量级、不超 STEP_MS。
   */
  DRAIN_GRACE_UNDER_SHELL_MS: 1_000,
  /** 排空 / 停止等待的轮询间隔（ms）。 */
  POLL_INTERVAL_MS: 250,
  /** `neo daemon stop` 发出 SIGTERM 后等 daemon 退出的上限（ms），须 ≥ DRAIN_GRACE_MS。 */
  STOP_WAIT_MS: 65_000,
  /**
   * win32 进程身份源/单实例锁的启用开关（N-RESIDENT-HOST-SHELL-WIN-ATTACH）。
   * 逻辑（PowerShell CIM 身份探针 + 解析 + 判别）已落地并被测试钉住，但开关
   * 保持 false：身份探针的输出形状是文档口径的夹具，还没在真 Windows 机上验过
   * （WIN-ATTACH-REALDEVICE 单独翻 true 并做三项真机检查）。放常量而不是
   * 函数内字面量，测试才能 vi.mock 整个常量模块来翻转。
   */
  WINDOWS_LOCK_ENABLED: false,
} as const;

/** Tauri boot handshake: a fresh 256-bit lowercase hex nonce per health probe. */
export const WEB_BOOT_CHALLENGE = {
  QUERY_PARAM: 'bootChallenge',
  HEX_LENGTH: 64,
  NON_HEX_PATTERN: /[^0-9a-f]/,
} as const;
