// ============================================================================
// API Middleware - 通用中间件函数
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkRateLimit, getClientIdentifier, type RateLimitConfig, RATE_LIMITS } from './rateLimit.js';

// 允许的 CORS 来源
const ALLOWED_ORIGINS = [
  'codeagent://',
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.CLIENT_URL,
].filter(Boolean) as string[];

/**
 * 设置 CORS 响应头
 * 限制为允许的来源，而非通配符
 */
export function setCorsHeaders(req: VercelRequest, res: VercelResponse): void {
  const origin = req.headers.origin;

  // 检查来源是否被允许
  if (origin && ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24小时缓存预检请求
}

/**
 * 处理 OPTIONS 预检请求
 */
export function handleOptions(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

/**
 * 应用 rate limiting
 * 返回 true 表示请求被限制
 */
export function applyRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  userId?: string,
  config: RateLimitConfig = RATE_LIMITS.default
): boolean {
  const identifier = getClientIdentifier(userId, req.headers as Record<string, string | string[] | undefined>);
  const result = checkRateLimit(identifier, config);

  // 设置 rate limit 响应头
  res.setHeader('X-RateLimit-Limit', config.max.toString());
  res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

  if (!result.allowed) {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
    });
    return true;
  }

  return false;
}

/**
 * 通用错误处理
 * 避免泄露内部错误信息
 */
export function handleError(
  res: VercelResponse,
  error: unknown,
  publicMessage = 'Internal server error'
): void {
  console.error('API Error:', error);
  res.status(500).json({ error: publicMessage });
}

/**
 * 验证必需的环境变量
 */
export function requireEnvVars(...vars: string[]): void {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
