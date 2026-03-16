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

/** Web Fetch 配置 */
export const WEB_FETCH = {
  /** 请求超时 (30s) */
  TIMEOUT: 30_000,
  /** 瞬态错误重试次数 */
  MAX_RETRIES: 1,
  /** 重试延迟 */
  RETRY_DELAY: 1000,
  /** 缓存 TTL (15 分钟，与 TOOL_CACHE.WEB_FETCH_TTL 对齐) */
  CACHE_TTL: 900_000,
  /** 缓存最大条目数 */
  CACHE_MAX_ENTRIES: 50,
  /** 受信文档内容直通上限 */
  TRUSTED_DOCS_MAX_CHARS: 100_000,
  /** 可重试 HTTP 状态码 */
  RETRYABLE_STATUS: [429, 500, 502, 503, 504],
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

// ============================================================================
// 云端 API 端点配置
// ============================================================================

/** 当前生产环境云端 API 基础 URL */
export const PRODUCTION_CLOUD_API_URL = 'https://code-agent-beta.vercel.app';

/** 默认云端 API 基础 URL */
const DEFAULT_CLOUD_API_URL = PRODUCTION_CLOUD_API_URL;

/** 获取云端 API URL（支持环境变量覆盖） */
export function getCloudApiUrl(): string {
  return (typeof process !== 'undefined' && process.env?.CLOUD_API_URL) || DEFAULT_CLOUD_API_URL;
}

/** 云端 API 端点 */
export const CLOUD_ENDPOINTS = {
  /** 获取基础 URL */
  get baseUrl() {
    return getCloudApiUrl();
  },
  /** 版本更新检查 */
  get update() {
    return `${getCloudApiUrl()}/api/update`;
  },
  /** 认证 */
  get auth() {
    return `${getCloudApiUrl()}/api/auth`;
  },
  /** 数据同步 */
  get sync() {
    return `${getCloudApiUrl()}/api/sync`;
  },
  /** System Prompt */
  get prompts() {
    return `${getCloudApiUrl()}/api/prompts`;
  },
  /** 模型代理 */
  get modelProxy() {
    return `${getCloudApiUrl()}/api/model-proxy`;
  },
  /** 云端工具（搜索/抓取等） */
  get tools() {
    return `${getCloudApiUrl()}/api/tools`;
  },
  /** 云端 Agent */
  get agent() {
    return `${getCloudApiUrl()}/api/agent`;
  },
  /** 云端配置 */
  get config() {
    return `${getCloudApiUrl()}/api/v1/config`;
  },
  /** 用户 API Key 管理 */
  get userKeys() {
    return `${getCloudApiUrl()}/api/user-keys`;
  },
  /** WebSocket 端点 */
  get websocket() {
    const url = getCloudApiUrl();
    return url.replace(/^https?:\/\//, 'wss://') + '/ws';
  },
} as const;

/** 默认 Supabase URL */
export const DEFAULT_SUPABASE_URL = 'https://xepbunahzbmexsmmiqyq.supabase.co';

/** 默认 Supabase Anonymous Key */
export const DEFAULT_SUPABASE_ANON_KEY = (typeof process !== 'undefined' && process.env?.SUPABASE_ANON_KEY) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcGJ1bmFoemJtZXhzbW1pcXlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODkyMTcsImV4cCI6MjA4NDA2NTIxN30.8swN1QdRX5vIjNyCLNhQTPAx-k2qxeS8EN4Ot2idY7w';
