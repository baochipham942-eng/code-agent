// ============================================================================
// middleware/auth.ts 行为：Bearer 鉴权失败路径、CORS 白名单、/api/run 限流。
// authTokenPath.test.ts 只覆盖 .dev-token 路径解析，不覆盖请求闸门。
// ============================================================================
import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVER_AUTH_TOKEN,
  authMiddleware,
  corsMiddleware,
  rateLimitMiddleware,
} from '../../../src/web/middleware/auth';

let server: http.Server | undefined;
let baseUrl = '';

async function start(app: express.Express): Promise<void> {
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
  baseUrl = '';
});

describe('authMiddleware', () => {
  async function startAuthApp() {
    const app = express();
    app.use((req, _res, next) => {
      // Express mounts strip prefix inconsistently in tests; force path for middleware.
      next();
    });
    app.use(authMiddleware);
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/screenshot', (_req, res) => res.json({ ok: true }));
    app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
    await start(app);
  }

  it('allows /health and /screenshot without a token', async () => {
    await startAuthApp();

    const health = await fetch(`${baseUrl}/health`);
    const screenshot = await fetch(`${baseUrl}/screenshot`);

    expect(health.status).toBe(200);
    expect(screenshot.status).toBe(200);
  });

  it('returns 401 when Authorization header is missing', async () => {
    await startAuthApp();

    const response = await fetch(`${baseUrl}/api/sessions`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Missing or invalid Authorization header',
    });
  });

  it('returns 403 when Bearer token is wrong', async () => {
    await startAuthApp();

    const response = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: 'Bearer 00000000-0000-4000-8000-000000000000' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid auth token',
    });
  });

  it('accepts the process SERVER_AUTH_TOKEN via Bearer header', async () => {
    await startAuthApp();

    const response = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${SERVER_AUTH_TOKEN}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('accepts the process SERVER_AUTH_TOKEN via ?token= query (SSE path)', async () => {
    await startAuthApp();

    const response = await fetch(
      `${baseUrl}/api/sessions?token=${encodeURIComponent(SERVER_AUTH_TOKEN)}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe('corsMiddleware', () => {
  async function startCorsApp() {
    const app = express();
    app.use(corsMiddleware);
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    await start(app);
  }

  it('reflects allowed origins and answers OPTIONS with 204', async () => {
    await startCorsApp();

    const options = await fetch(`${baseUrl}/api/ping`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect(options.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('does not set Access-Control-Allow-Origin for disallowed origins', async () => {
    await startCorsApp();

    const response = await fetch(`${baseUrl}/api/ping`, {
      headers: { Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('rateLimitMiddleware', () => {
  it('returns 429 after exceeding /api/run window quota', async () => {
    const app = express();
    // rateLimitMiddleware keys on req.path; mount at root so path is /api/run
    app.use(rateLimitMiddleware);
    app.post('/api/run', (_req, res) => res.json({ ok: true }));
    await start(app);

    let lastStatus = 0;
    let hit429 = false;
    // Rule: /api/run max 10 / 60s — send 12 to force a reject
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(`${baseUrl}/api/run`, { method: 'POST' });
      lastStatus = response.status;
      if (response.status === 429) {
        hit429 = true;
        expect(response.headers.get('retry-after')).toBeTruthy();
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringMatching(/Too many requests/i),
        });
        break;
      }
    }

    expect(hit429).toBe(true);
    expect(lastStatus).toBe(429);
  });
});
