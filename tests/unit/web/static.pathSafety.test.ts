// ============================================================================
// static 路由路径安全：扩展名资源 404 不回 SPA、路径穿越不泄露文件、
// 缺 index.html 时明确 404。staticRouter.test.ts 未覆盖穿越与 SPA 边界。
// ============================================================================
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStaticRouter } from '../../../src/web/routes/static';

let staticDir: string;
let secretOutside: string;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-static-safety-'));
  secretOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-secret-'));
  fs.writeFileSync(path.join(secretOutside, 'secret.txt'), 'TOP-SECRET', 'utf-8');
  fs.mkdirSync(path.join(staticDir, 'assets'));
  fs.writeFileSync(
    path.join(staticDir, 'index.html'),
    '<!doctype html><html><head></head><body>APP</body></html>',
    'utf-8',
  );
  fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)', 'utf-8');

  const app = express();
  app.use(createStaticRouter({
    serverAuthToken: 'safety-token',
    staticDir,
  }));

  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  fs.rmSync(staticDir, { recursive: true, force: true });
  fs.rmSync(secretOutside, { recursive: true, force: true });
});

describe('createStaticRouter path safety', () => {
  it('does not serve path-traversal attempts into sibling directories', async () => {
    // encode ../ segments; must not leak TOP-SECRET from outside staticDir
    const encoded = encodeURIComponent(`../${path.basename(secretOutside)}/secret.txt`);
    const response = await fetch(`${baseUrl}/${encoded}`);
    const body = await response.text();

    expect(body).not.toContain('TOP-SECRET');
    // Either 404 from asset rule / missing file, or SPA shell — never secret content
    expect([200, 404]).toContain(response.status);
    if (response.status === 200) {
      expect(body).toContain('APP');
    }
  });

  it('returns plain 404 for missing assets with an extension (no SPA HTML)', async () => {
    const response = await fetch(`${baseUrl}/assets/../secret.txt`);
    const body = await response.text();

    expect(body).not.toContain('TOP-SECRET');
    expect(body).not.toContain('<!doctype html>');
    // path has extension → SPA fallback short-circuits to 404 text
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').toMatch(/text/);
  });

  it('returns 404 text for dotted paths that are not real assets', async () => {
    const response = await fetch(`${baseUrl}/config.json`);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toBe('Static asset not found');
    expect(body).not.toContain('window.__CODE_AGENT_TOKEN__');
  });

  it('returns 404 when index.html is missing from the serve dir', async () => {
    fs.unlinkSync(path.join(staticDir, 'index.html'));

    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toBe('index.html not found');
  });

  it('still serves legitimate hashed-looking assets from assets/', async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('console.log(1)');
  });
});
