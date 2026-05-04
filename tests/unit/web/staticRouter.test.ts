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
    expect(body).toContain('window.__CODE_AGENT_TOKEN__="test-token"');
  });
});
