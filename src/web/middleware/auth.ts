// ============================================================================
// Auth/Security Middleware — CORS, Rate Limiting, Bearer Token Authentication
// ============================================================================

import { randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../main/services/infra/logger';

const logger = createLogger('AuthMiddleware');

// ── Server Auth Token ─────────────────────────────────────────────────────
/**
 * 启动时先复用 .dev-token 里的旧 token（dev convenience），没有或格式不合法
 * 才生成新的。复用后 kill/restart webServer 不会让 Tauri WebView 里固化的
 * token 失效，避免 "Invalid auth token" 踩坑。
 *
 * .dev-token 写入由 webServer.ts 负责（listen callback），
 * 若进程 crash 未清理，下次启动就会复用上次的 token — 这正是我们想要的。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveDevMirrorTokenPath(cwd = process.cwd()): string | null {
  const normalizedCwd = path.resolve(cwd);
  const packageJsonPath = path.join(normalizedCwd, 'package.json');
  const rendererRoot = path.join(normalizedCwd, 'src', 'renderer');
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(rendererRoot)) {
    return null;
  }
  return path.join(normalizedCwd, '.dev-token');
}

export function resolveDevAuthTokenPath(cwd = process.cwd()): string {
  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim() || path.join(os.homedir(), '.code-agent');
  const normalizedCwd = path.normalize(cwd);
  const segments = normalizedCwd.split(path.sep).filter(Boolean);
  const isPackagedResourceCwd = segments.some((segment, index) =>
    segment.endsWith('.app') &&
    segments[index + 1] === 'Contents' &&
    segments[index + 2] === 'Resources'
  );

  return path.join(isPackagedResourceCwd ? dataDir : cwd, '.dev-token');
}

function loadOrGenerateAuthToken(): string {
  const devTokenPath = resolveDevAuthTokenPath();
  try {
    const existing = fs.readFileSync(devTokenPath, 'utf-8').trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    // ENOENT or unreadable — fall through to fresh generation
  }
  return randomUUID();
}

export function writeDevAuthToken(token: string, cwd = process.cwd()): void {
  const devTokenPath = resolveDevAuthTokenPath(cwd);
  fs.mkdirSync(path.dirname(devTokenPath), { recursive: true });
  fs.writeFileSync(devTokenPath, token, 'utf-8');

  const repoDevTokenPath = resolveDevMirrorTokenPath(process.cwd());
  if (repoDevTokenPath && repoDevTokenPath !== devTokenPath) {
    fs.writeFileSync(repoDevTokenPath, token, 'utf-8');
  }
}

/** Loaded from .dev-token on startup (dev) or freshly generated; printed to stdout for Tauri/frontend */
export const SERVER_AUTH_TOKEN = loadOrGenerateAuthToken();

// ── CORS ──────────────────────────────────────────────────────────────────
/** Allowed CORS origins */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:8180',
  'http://127.0.0.1:8180',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'https://tauri.localhost',
]);

// 测试包 webServer 跑在非默认端口（如 8181），其渲染器同源请求一般不触发 CORS，
// 但稳妥起见把运行时实际端口的 localhost/127.0.0.1 origin 也加进白名单。
const runtimePort = (process.env.WEB_PORT || process.env.CODE_AGENT_WEB_PORT || '').trim();
if (runtimePort) {
  ALLOWED_ORIGINS.add(`http://localhost:${runtimePort}`);
  ALLOWED_ORIGINS.add(`http://127.0.0.1:${runtimePort}`);
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // If no origin header (e.g. same-origin, curl), don't set the header at all
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

// ── Rate Limiting ─────────────────────────────────────────────────────────
/** Rate limit config: route pattern -> { max requests, window in ms } */
const RATE_LIMITS: Array<{ pattern: string | RegExp; max: number; windowMs: number }> = [
  { pattern: '/api/run', max: 10, windowMs: 60_000 },
  { pattern: '/api/upload/temp', max: 20, windowMs: 60_000 },
  { pattern: /^\/api\//, max: 100, windowMs: 60_000 },
];

/** In-memory rate limit store: key -> timestamps */
const rateLimitStore = new Map<string, number[]>();

function getRateLimitKey(ip: string, pattern: string | RegExp): string {
  return `${ip}:${String(pattern)}`;
}

function checkRateLimit(ip: string, routePath: string): { allowed: boolean; retryAfterMs?: number } {
  for (const rule of RATE_LIMITS) {
    const matches = typeof rule.pattern === 'string'
      ? routePath === rule.pattern
      : rule.pattern.test(routePath);
    if (!matches) continue;

    const key = getRateLimitKey(ip, rule.pattern);
    const now = Date.now();
    const timestamps = rateLimitStore.get(key) || [];
    const valid = timestamps.filter((t) => now - t < rule.windowMs);

    if (valid.length >= rule.max) {
      const oldestValid = valid[0];
      const retryAfterMs = rule.windowMs - (now - oldestValid);
      return { allowed: false, retryAfterMs };
    }

    valid.push(now);
    rateLimitStore.set(key, valid);
    return { allowed: true };
  }
  return { allowed: true };
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = checkRateLimit(ip, req.path);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((result.retryAfterMs || 60_000) / 1000)));
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return;
  }
  next();
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
// 捕获 handle 用于 graceful shutdown 时清理；.unref() 保证 handle 不阻塞进程退出
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore) {
    const valid = timestamps.filter((t) => now - t < 120_000);
    if (valid.length === 0) {
      rateLimitStore.delete(key);
    } else {
      rateLimitStore.set(key, valid);
    }
  }
}, 5 * 60_000);
rateLimitCleanupTimer.unref();

// Lazy import 避免 main → web 反向依赖，且 web middleware 单独跑（CLI/test）时不强求 shutdown infra
import('../../main/services/infra/gracefulShutdown')
  .then(({ onShutdown }) => {
    onShutdown('web/auth.rateLimitCleanup', async () => {
      clearInterval(rateLimitCleanupTimer);
    });
  })
  .catch(() => { /* gracefulShutdown 不可用就纯靠 .unref() 兜底 */ });

// ── Authentication ────────────────────────────────────────────────────────
/** Constant-time token comparison to prevent timing attacks */
function verifyToken(provided: string): boolean {
  const expected = Buffer.from(SERVER_AUTH_TOKEN, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Health and screenshot endpoints are exempt from auth
  if (req.path === '/health' || req.path === '/screenshot') {
    next();
    return;
  }
  // Accept token from Authorization header or query param (for SSE EventSource)
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  let token: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (queryToken) {
    token = queryToken;
  }
  if (!token) {
    // 启动期连刷排查锚点：缓存的旧启动文档会带旧/缺 token 打 API，触发前端强制 reload
    logger.warn(`401 missing token: ${req.method} ${req.path}`);
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  if (!verifyToken(token)) {
    logger.warn(`403 invalid token: ${req.method} ${req.path}`);
    res.status(403).json({ error: 'Invalid auth token' });
    return;
  }
  next();
}
