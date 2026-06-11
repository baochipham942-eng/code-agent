import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStaticRouter } from '../../../src/web/routes/static';

let staticDir: string;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-static-'));
  fs.mkdirSync(path.join(staticDir, 'assets'));
  fs.writeFileSync(
    path.join(staticDir, 'index.html'),
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    'utf-8',
  );

  const app = express();
  app.use(createStaticRouter({
    serverAuthToken: 'test-token',
    staticDir,
  }));

  server = await new Promise<http.Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  fs.rmSync(staticDir, { recursive: true, force: true });
});

describe('createStaticRouter', () => {
  it('does not serve index.html for missing hashed assets', async () => {
    const response = await fetch(`${baseUrl}/assets/index-missing.js`);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).not.toContain('<!doctype html>');
    expect(body).not.toContain('window.__CODE_AGENT_TOKEN__');
  });

  it('still injects the auth token for app routes', async () => {
    const response = await fetch(`${baseUrl}/sessions/session-1`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('window.__CODE_AGENT_TOKEN__="test-token";window.__CODE_AGENT_RENDERER_BUNDLE__=null');
  });

  it('serves index.html with Cache-Control: no-store (token rotates per boot, stale cache causes 401+reload loop)', async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('injects the auth token when the built index has a formatted head tag', async () => {
    fs.writeFileSync(
      path.join(staticDir, 'index.html'),
      '<!doctype html><html>\\n  <head data-vite="true">\\n  </head><body><div id="root"></div></body></html>',
      'utf-8',
    );

    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<head data-vite="true"><script>window.__CODE_AGENT_TOKEN__="test-token";window.__CODE_AGENT_RENDERER_BUNDLE__=null;</script>',
    );
  });
});

// ── 循环4：运行时 serve 目录解析（包内基线 ⇄ 云端 active 热更）────────────
describe('createStaticRouter — runtime serve dir resolution', () => {
  let dataDir: string;
  let builtinDir: string;
  let rtServer: http.Server;
  let rtBaseUrl: string;

  function writeBuiltin(): void {
    fs.writeFileSync(
      path.join(builtinDir, 'index.html'),
      '<!doctype html><html><head></head><body>BUILTIN</body></html>',
      'utf-8',
    );
  }

  function writeActiveBundle(version = '9.9.9'): void {
    const active = path.join(dataDir, 'renderer-cache', 'active');
    fs.mkdirSync(path.join(active, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(active, 'index.html'),
      '<!doctype html><html><head></head><body>CLOUD</body></html>',
      'utf-8',
    );
    fs.writeFileSync(path.join(active, 'assets', 'app.js'), 'console.log("cloud-asset")', 'utf-8');
    fs.writeFileSync(
      path.join(active, '.bundle-meta.json'),
      JSON.stringify({ version, contentHash: 'deadbeef' }),
      'utf-8',
    );
  }

  async function startServer(options: { currentShellVersion?: string } = {}): Promise<void> {
    const app = express();
    app.use(createStaticRouter({
      serverAuthToken: 'rt-token',
      dataDir,
      builtinDir,
      currentShellVersion: options.currentShellVersion,
    }));
    rtServer = await new Promise<http.Server>((resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = rtServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server address');
    rtBaseUrl = `http://127.0.0.1:${address.port}`;
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-data-'));
    builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-builtin-'));
    fs.mkdirSync(path.join(builtinDir, 'assets'));
    writeBuiltin();
  });

  afterEach(async () => {
    if (rtServer) {
      await new Promise<void>((resolve, reject) => {
        rtServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(builtinDir, { recursive: true, force: true });
  });

  it('serves builtin index when no active bundle exists', async () => {
    await startServer();
    const response = await fetch(`${rtBaseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('BUILTIN');
    expect(body).toContain('window.__CODE_AGENT_TOKEN__="rt-token";window.__CODE_AGENT_RENDERER_BUNDLE__=null');
  });

  it('serves cloud active index when active bundle is healthy', async () => {
    writeActiveBundle();
    await startServer();
    const response = await fetch(`${rtBaseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('CLOUD');
    expect(body).not.toContain('BUILTIN');
    expect(body).toContain('window.__CODE_AGENT_TOKEN__="rt-token"');
    expect(body).toContain('window.__CODE_AGENT_RENDERER_BUNDLE__={"version":"9.9.9","contentHash":"deadbeef"}');
  });

  it('serves builtin index when active bundle is older than the current shell', async () => {
    writeActiveBundle('0.16.101');
    await startServer({ currentShellVersion: '0.16.102' });
    const response = await fetch(`${rtBaseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('BUILTIN');
    expect(body).not.toContain('CLOUD');
    expect(body).toContain('window.__CODE_AGENT_RENDERER_BUNDLE__=null');
  });

  it('serves static assets from the active bundle dir', async () => {
    writeActiveBundle();
    await startServer();
    const response = await fetch(`${rtBaseUrl}/assets/app.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('cloud-asset');
  });

  it('resets cached index.html when serve dir switches to active', async () => {
    await startServer();
    const first = await (await fetch(`${rtBaseUrl}/`)).text();
    expect(first).toContain('BUILTIN');

    // active 出现后再次请求应切到云端版（缓存按 serve 目录重置）
    writeActiveBundle();
    const second = await (await fetch(`${rtBaseUrl}/`)).text();
    expect(second).toContain('CLOUD');
    expect(second).not.toContain('BUILTIN');
  });

  it('resets cached index.html when active bundle is removed and serve dir falls back', async () => {
    writeActiveBundle();
    await startServer();
    const first = await (await fetch(`${rtBaseUrl}/`)).text();
    expect(first).toContain('CLOUD');
    expect(first).not.toContain('BUILTIN');

    fs.rmSync(path.join(dataDir, 'renderer-cache', 'active'), { recursive: true, force: true });
    const second = await (await fetch(`${rtBaseUrl}/`)).text();
    expect(second).toContain('BUILTIN');
    expect(second).not.toContain('CLOUD');
    expect(second).toContain('window.__CODE_AGENT_TOKEN__="rt-token";window.__CODE_AGENT_RENDERER_BUNDLE__=null');
  });

  it('falls back to builtin when active bundle is unhealthy (missing index.html)', async () => {
    const active = path.join(dataDir, 'renderer-cache', 'active');
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(
      path.join(active, '.bundle-meta.json'),
      JSON.stringify({ version: '9.9.9', contentHash: 'deadbeef' }),
      'utf-8',
    );
    // 故意不写 index.html → 不健康
    await startServer();
    const body = await (await fetch(`${rtBaseUrl}/`)).text();

    expect(body).toContain('BUILTIN');
  });
});
