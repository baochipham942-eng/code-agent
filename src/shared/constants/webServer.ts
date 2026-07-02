/** web SSE 防滥用（WP3-4）：per-token 并发连接上限（长连接不受滑动窗口 rateLimit 约束，须单独设并发闸） */
export const WEB_SSE = {
  /** /api/run 每 token 最大并发 SSE 流（对齐 spawnGuard maxAgents=8 的并行会话上限） */
  MAX_CONCURRENT_PER_TOKEN: 8,
} as const;

export const WEB_SERVER_DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: 8180,
  HEALTH_PATH: '/api/health',
  WORKSPACE_FILE_PATH: '/api/workspace/file',
  DEV_AUTH_TOKEN_FILE: '.dev-token',
} as const;
