import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInternalFeaturesRouter } from '../../../src/web/routes/internalFeatures';
import { INTERNAL_SDK_VERSION } from '../../../src/host/internalFeatures/internalSdkVersion';
import type { LoadedPlugin } from '../../../src/host/plugins/types';

let pluginsDir: string;
let server: http.Server;
let baseUrl: string;
let loaded: boolean;
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  pluginsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-internal-route-'));
  const rendererDir = path.join(pluginsDir, 'evaluation-center', 'dist', 'renderer');
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, 'index.js'), 'window.TEST_PLUGIN = true;', 'utf8');
  await fs.writeFile(path.join(pluginsDir, 'evaluation-center', 'dist', 'secret.js'), 'DO-NOT-SERVE', 'utf8');
  loaded = true;
  originalEnv = {
    CODE_AGENT_WEB_MODE: process.env.CODE_AGENT_WEB_MODE,
    CODE_AGENT_E2E: process.env.CODE_AGENT_E2E,
    CODE_AGENT_ENABLE_DEV_API: process.env.CODE_AGENT_ENABLE_DEV_API,
  };
  process.env.CODE_AGENT_WEB_MODE = 'true';
  process.env.CODE_AGENT_E2E = '1';
  delete process.env.CODE_AGENT_ENABLE_DEV_API;

  const plugin: LoadedPlugin = {
    manifest: {
      id: 'evaluation-center',
      name: 'evaluation-center',
      version: '1.0.0',
      main: 'index.js',
      surfaces: ['internal-feature'],
      internalFeature: {
        id: 'evaluation-center',
        label: '评测中心',
        sdkVersion: INTERNAL_SDK_VERSION,
        rendererEntry: 'dist/renderer/index.js',
        rendererStyles: 'dist/renderer/index.css',
        hostEntry: 'dist/host/index.cjs',
      },
    },
    rootPath: path.join(pluginsDir, 'evaluation-center'),
    state: 'active',
    registeredTools: [],
  };
  const app = express();
  app.use(createInternalFeaturesRouter({
    runtime: { isLoaded: () => loaded, loadedHash: () => loaded ? 'fixture-hash' : undefined },
    registry: { getPlugin: (id) => id === plugin.manifest.id ? plugin : undefined },
    pluginsDir,
  }));
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route fixture did not get a port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(pluginsDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createInternalFeaturesRouter', () => {
  it('serves only loaded admin plugin files and blocks traversal without existence leaks', async () => {
    const ok = await fetch(`${baseUrl}/internal-features/evaluation-center/index.js?v=fixture`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('TEST_PLUGIN');
    expect(ok.headers.get('cache-control')).toBe('no-cache');

    const traversal = await fetch(`${baseUrl}/internal-features/evaluation-center/..%2Fsecret.js`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('DO-NOT-SERVE');

    loaded = false;
    expect((await fetch(`${baseUrl}/internal-features/evaluation-center/index.js`)).status).toBe(404);

    loaded = true;
    delete process.env.CODE_AGENT_E2E;
    expect((await fetch(`${baseUrl}/internal-features/evaluation-center/index.js`)).status).toBe(404);
  });
});
