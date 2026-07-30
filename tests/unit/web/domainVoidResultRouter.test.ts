import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainRouter } from '../../../src/web/routes/domain';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

// void 通道（写操作，handler 无返回值）经 web 桥必须回合法 JSON。
// 修前：res.json(undefined) 发空 body 200 → renderer 的 response.json() 抛
// "Unexpected end of JSON input" → 用户看到「技能设置失败」，可 host 其实已经写成功
// （2026-07-30 产品负责人真机撞到，空间右栏选技能）。
let server: http.Server | undefined;
let baseUrl = '';

const logger = { warn: vi.fn(), error: vi.fn() };

async function startApi(handlers: Map<string, WebRouteHandler>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createDomainRouter({ handlers, logger }));
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((err) => (err ? reject(err) : resolve())));
  server = undefined;
  baseUrl = '';
  vi.clearAllMocks();
});

describe('domain router：void handler 的响应体', () => {
  beforeEach(() => vi.clearAllMocks());

  it('多段通道（skill:project:set 这类写操作）返回 undefined 时回 null，不是空 body', async () => {
    const handler = vi.fn(async () => undefined);
    await startApi(new Map<string, WebRouteHandler>([['skill:project:set', handler as unknown as WebRouteHandler]]));

    const response = await fetch(`${baseUrl}/api/skill/project/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['excel', true, '/tmp/ws']),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toBe('');
    expect(JSON.parse(text)).toBeNull();
    // 位置参数照旧按 Electron IPC 约定展开
    expect(handler).toHaveBeenCalledWith(null, 'excel', true, '/tmp/ws');
  });

  it('domain:action 直连通道 void 结果同样回 null', async () => {
    const handler = vi.fn(async () => undefined);
    await startApi(new Map<string, WebRouteHandler>([['project:doThing', handler as unknown as WebRouteHandler]]));

    const response = await fetch(`${baseUrl}/api/project/doThing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { a: 1 } }),
    });

    expect(JSON.parse(await response.text())).toBeNull();
  });

  it('有返回值的通道原样透传（兜底不改变正常语义）', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    await startApi(new Map<string, WebRouteHandler>([['skill:list', handler as unknown as WebRouteHandler]]));

    const response = await fetch(`${baseUrl}/api/skill/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });

    expect(await response.json()).toEqual({ ok: true });
  });
});
