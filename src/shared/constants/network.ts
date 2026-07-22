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
  /** 控制面货架缓存 TTL（5 分钟） */
  REGISTRY_CACHE_TTL: 5 * 60 * 1000,
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

/** Agent Neo 帮助与产品文档入口 */
export const AGENT_NEO_HELP_URL = 'https://github.com/baochipham942-eng/code-agent';

/** 当前生产环境云端 API 基础 URL */
export const PRODUCTION_CLOUD_API_URL = 'https://agentneo.vercel.app';

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
  /** 官方 Skill Registry（签名控制面） */
  get skillRegistry() {
    return `${getCloudApiUrl()}/api/v1/skill-registry`;
  },
  /** 官方 Role Pack Registry（签名控制面） */
  get roleRegistry() {
    return `${getCloudApiUrl()}/api/v1/role-registry`;
  },
  /** WebSocket 端点 */
  get websocket() {
    const url = getCloudApiUrl();
    return url.replace(/^https?:\/\//, 'wss://') + '/ws';
  },
} as const;

/** QuickChart API（chart_generate tool 使用） */
export const QUICKCHART_API = 'https://quickchart.io/chart';

/** HTTP 请求响应体大小上限（http_request tool 使用） */
export const HTTP_MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

/** Twitter/X 抓取端点（twitter_fetch tool 使用） */
export const TWITTER_API_ENDPOINTS = {
  FXTWITTER: 'https://api.fxtwitter.com',
  VXTWITTER: 'https://api.vxtwitter.com',
  NITTER_INSTANCES: ['nitter.net', 'nitter.it', 'nitter.privacydev.net'] as readonly string[],
} as const;

/** YouTube 字幕端点（youtube_transcript tool 使用） */
export const YOUTUBE_TRANSCRIPT_ENDPOINTS = {
  SUPADATA: 'https://api.supadata.ai/v1/youtube/transcript',
  OEMBED: 'https://www.youtube.com/oembed',
  FALLBACK: ['https://yt.lemnoslife.com/videos'] as readonly string[],
} as const;

/** 学术搜索端点（academic_search tool 使用） */
export const ACADEMIC_SEARCH_ENDPOINTS = {
  ARXIV: 'https://export.arxiv.org/api/query',
  SEMANTIC_SCHOLAR: 'https://api.semanticscholar.org/graph/v1/paper/search',
} as const;

/** 学术搜索结果上限 */
export const ACADEMIC_SEARCH_MAX_LIMIT = 30;

/** Jira REST API 版本路径（jira tool 使用） */
export const JIRA_API_VERSION_PATH = '/rest/api/3';

// ============================================================================
// 前端热更（renderer hot update）OSS 端点
// ============================================================================

/** OSS 发布资源 bucket 基础 URL（阿里云上海，与整包发版同 bucket） */
export const OSS_RELEASES_BASE_URL = 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com';

/** 前端热更 channel 环境变量；空值/latest 走生产入口，非 latest 走 renderer-bundle/channels/<channel>/ */
export const RENDERER_BUNDLE_CHANNEL_ENV = 'CODE_AGENT_RENDERER_BUNDLE_CHANNEL';

/** 前端热更 manifest 完整 URL override；用于内部 canary 或临时验证，manifest 仍必须通过签名校验。 */
export const RENDERER_BUNDLE_MANIFEST_URL_ENV = 'CODE_AGENT_RENDERER_BUNDLE_MANIFEST_URL';

/** 前端热更灰度策略 URL；配置后先拉 signed renderer_bundle_rollout policy，再选择 manifest。 */
export const RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV = 'CODE_AGENT_RENDERER_BUNDLE_ROLLOUT_POLICY_URL';

/** 前端热更 cohort 标签；配合 rollout policy 做内部灰度或员工环。 */
export const RENDERER_BUNDLE_COHORT_ENV = 'CODE_AGENT_RENDERER_BUNDLE_COHORT';

export type RendererBundleEndpointErrorCode =
  | 'invalid-renderer-bundle-channel'
  | 'invalid-renderer-bundle-manifest-url'
  | 'invalid-renderer-bundle-rollout-policy-url';

export class RendererBundleEndpointError extends Error {
  readonly code: RendererBundleEndpointErrorCode;
  readonly target: string;

  constructor(code: RendererBundleEndpointErrorCode, message: string, target: string) {
    super(message);
    this.name = 'RendererBundleEndpointError';
    this.code = code;
    this.target = target;
  }
}

const RENDERER_BUNDLE_DEFAULT_CHANNEL = 'latest';
const RENDERER_BUNDLE_CHANNEL_PATTERN = /^[A-Za-z0-9._-]+$/;

type RendererBundleEndpointEnv = {
  [RENDERER_BUNDLE_CHANNEL_ENV]?: string;
  [RENDERER_BUNDLE_MANIFEST_URL_ENV]?: string;
  [RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]?: string;
  [RENDERER_BUNDLE_COHORT_ENV]?: string;
};

export interface RendererBundleEndpointResolution {
  channel: string;
  manifestUrl: string;
  manifestUrlOverride?: boolean;
  rolloutPolicyUrl?: string;
  rolloutPolicyUrlOverride?: boolean;
  cohort?: string;
}

function getRendererBundleEndpointEnv(): RendererBundleEndpointEnv {
  return (typeof process !== 'undefined' && process.env) || {};
}

function rendererBundleManifestUrlForChannel(channel: string): string {
  if (channel === RENDERER_BUNDLE_DEFAULT_CHANNEL) {
    return `${OSS_RELEASES_BASE_URL}/renderer-bundle/latest/manifest.json`;
  }
  return `${OSS_RELEASES_BASE_URL}/renderer-bundle/channels/${encodeURIComponent(channel)}/manifest.json`;
}

function assertHttpUrl(value: string, code: RendererBundleEndpointErrorCode, envName: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return;
  } catch {
    // fall through to the typed endpoint error below
  }
  throw new RendererBundleEndpointError(
    code,
    `${envName} must be an http(s) URL`,
    value,
  );
}

function assertHttpManifestUrl(value: string): void {
  assertHttpUrl(
    value,
    'invalid-renderer-bundle-manifest-url',
    RENDERER_BUNDLE_MANIFEST_URL_ENV,
  );
}

function assertHttpRolloutPolicyUrl(value: string): void {
  assertHttpUrl(
    value,
    'invalid-renderer-bundle-rollout-policy-url',
    RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV,
  );
}

export function getRendererBundleChannel(env: RendererBundleEndpointEnv = getRendererBundleEndpointEnv()): string {
  const channel = env[RENDERER_BUNDLE_CHANNEL_ENV]?.trim() || RENDERER_BUNDLE_DEFAULT_CHANNEL;
  if (channel === RENDERER_BUNDLE_DEFAULT_CHANNEL) return RENDERER_BUNDLE_DEFAULT_CHANNEL;
  if (!RENDERER_BUNDLE_CHANNEL_PATTERN.test(channel)) {
    throw new RendererBundleEndpointError(
      'invalid-renderer-bundle-channel',
      `${RENDERER_BUNDLE_CHANNEL_ENV} may only contain letters, numbers, dot, underscore, or dash`,
      `${RENDERER_BUNDLE_CHANNEL_ENV}=${channel}`,
    );
  }
  return channel;
}

export function resolveRendererBundleEndpoint(
  env: RendererBundleEndpointEnv = getRendererBundleEndpointEnv(),
): RendererBundleEndpointResolution {
  const manifestUrlOverride = env[RENDERER_BUNDLE_MANIFEST_URL_ENV]?.trim();
  const rolloutPolicyUrl = env[RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]?.trim();
  const cohort = env[RENDERER_BUNDLE_COHORT_ENV]?.trim();
  const sourcePatch = {
    ...(rolloutPolicyUrl
      ? (
        assertHttpRolloutPolicyUrl(rolloutPolicyUrl),
        { rolloutPolicyUrl, rolloutPolicyUrlOverride: true }
      )
      : {}),
    ...(cohort ? { cohort } : {}),
  };
  if (manifestUrlOverride) {
    assertHttpManifestUrl(manifestUrlOverride);
    return {
      channel: env[RENDERER_BUNDLE_CHANNEL_ENV]?.trim() || RENDERER_BUNDLE_DEFAULT_CHANNEL,
      manifestUrl: manifestUrlOverride,
      manifestUrlOverride: true,
      ...sourcePatch,
    };
  }
  const channel = getRendererBundleChannel(env);
  return {
    channel,
    manifestUrl: rendererBundleManifestUrlForChannel(channel),
    ...sourcePatch,
  };
}

export function getRendererBundleManifestUrl(
  env: RendererBundleEndpointEnv = getRendererBundleEndpointEnv(),
): string {
  return resolveRendererBundleEndpoint(env).manifestUrl;
}

/** 前端热更 bundle OSS 端点（manifest 为签名 envelope，bundle.tar.gz 地址在 manifest.payload 内） */
export const RENDERER_BUNDLE_ENDPOINTS = {
  /** 最新前端 bundle 的签名 manifest（控制面入口） */
  get manifestUrl() {
    return getRendererBundleManifestUrl();
  },
  /** 按传入环境变量解析 manifest URL，默认 latest，可指向 channel 或完整 URL override。 */
  getManifestUrl(env?: RendererBundleEndpointEnv) {
    return getRendererBundleManifestUrl(env);
  },
} as const;

/** 默认 Supabase URL */
export const DEFAULT_SUPABASE_URL = 'https://xepbunahzbmexsmmiqyq.supabase.co';

/** 默认 Supabase Anonymous Key */
export const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcGJ1bmFoemJtZXhzbW1pcXlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODkyMTcsImV4cCI6MjA4NDA2NTIxN30.8swN1QdRX5vIjNyCLNhQTPAx-k2qxeS8EN4Ot2idY7w';
