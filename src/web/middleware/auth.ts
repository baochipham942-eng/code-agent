// ============================================================================
// Auth/Security Middleware — CORS, Rate Limiting, Bearer Token Authentication
// ============================================================================

import { randomUUID, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// ── Server Auth Token ─────────────────────────────────────────────────────
/** Generated on startup, printed to stdout for Tauri/frontend */
export const SERVER_AUTH_TOKEN = randomUUID();

// ── CORS ──────────────────────────────────────────────────────────────────
/** Allowed CORS origins */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:8180',
  'http://127.0.0.1:8180',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'https://tauri.localhost',
]);

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
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore) {
    const valid = timestamps.filter((t) => now - t < 120_000);
    if (valid.length === 0) {
      rateLimitStore.delete(key);
    } else {
      rateLimitStore.set(key, valid);
    }
  }
}, 5 * 60_000).unref();

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
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  if (!verifyToken(token)) {
    res.status(403).json({ error: 'Invalid auth token' });
    return;
  }
  next();
}
