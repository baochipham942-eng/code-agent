import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createShellRouter } from '../../../src/web/routes/shell';

let server: http.Server | null = null;

async function startServer(): Promise<string> {
  const app = express();
  app.use('/api', createShellRouter({
    getAppVersion: () => '9.9.9',
    now: () => new Date('2026-06-06T00:00:00.000Z'),
  }));
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => (err ? reject(err) : resolve()));
  });
  server = null;
});

describe('createShellRouter', () => {
  it('exposes the current shell capability manifest', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/shell/capabilities`);
    const body = await response.json() as {
      schemaVersion: number;
      appVersion: string;
      generatedAt: string;
      capabilities: Array<{ id: string; domain: string; action: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.schemaVersion).toBe(1);
    expect(body.appVersion).toBe('9.9.9');
    expect(body.generatedAt).toBe('2026-06-06T00:00:00.000Z');
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'domain:update/check',
          domain: 'domain:update',
          action: 'check',
        }),
        expect.objectContaining({
          id: 'native:tauri/desktop_get_capabilities',
          domain: 'native:tauri',
          action: 'desktop_get_capabilities',
        }),
      ]),
    );
  });
});
