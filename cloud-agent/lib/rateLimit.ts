// ============================================================================
// Rate Limiting - 简单的内存级别限流
// 注意：Serverless 函数每次调用可能是新实例，这只能提供基础保护
// 生产环境建议使用 Vercel Edge Config 或 Upstash Redis
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// 内存存储（每个 serverless 实例独立）
const store = new Map<string, RateLimitEntry>();

// 清理过期条目
function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}

export interface RateLimitConfig {
  windowMs: number;  // 时间窗口（毫秒）
  max: number;       // 最大请求数
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// 默认配置：每分钟 60 次请求
const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60 * 1000,
  max: 60,
};

/**
 * 检查是否允许请求
 * @param identifier - 唯一标识符（如 IP 地址、用户 ID）
 * @param config - 限流配置
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = DEFAULT_CONFIG
): RateLimitResult {
  // 定期清理
  if (Math.random() < 0.1) {
    cleanupExpired();
  }

  const now = Date.now();
  const key = identifier;
  let entry = store.get(key);

  // 如果没有条目或已过期，创建新条目
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + config.windowMs,
    };
    store.set(key, entry);
  }

  entry.count++;

  return {
    allowed: entry.count <= config.max,
    remaining: Math.max(0, config.max - entry.count),
    resetAt: entry.resetAt,
  };
}

/**
 * 获取客户端标识符
 * 优先使用用户 ID，其次是 IP 地址
 */
export function getClientIdentifier(
  userId?: string,
  headers?: { [key: string]: string | string[] | undefined }
): string {
  if (userId) {
    return `user:${userId}`;
  }

  // 尝试从 headers 获取真实 IP
  const forwarded = headers?.['x-forwarded-for'];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return `ip:${ip.trim()}`;
  }

  const realIp = headers?.['x-real-ip'];
  if (realIp) {
    return `ip:${Array.isArray(realIp) ? realIp[0] : realIp}`;
  }

  return 'ip:unknown';
}

// 预设配置
export const RATE_LIMITS = {
  // 认证相关：更严格
  auth: { windowMs: 60 * 1000, max: 10 },
  // 同步操作：中等
  sync: { windowMs: 60 * 1000, max: 30 },
  // Agent 聊天：较宽松但有限制
  agent: { windowMs: 60 * 1000, max: 20 },
  // 更新检查：宽松
  update: { windowMs: 60 * 1000, max: 60 },
  // 默认
  default: { windowMs: 60 * 1000, max: 60 },
} as const;
