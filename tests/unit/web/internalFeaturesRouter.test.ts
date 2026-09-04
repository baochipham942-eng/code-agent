import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInternalFeaturesRouter } from '../../../src/web/routes/internalFeatures';
import { INTERNAL_SDK_VERSION } from '../../../src/host/internalFeatures/internalSdkVersion';
import type { LoadedPlugin } from '../../../src/host/plugins/types';

let tmpRoot: string;
let pluginsDir: string;
let server: http.Server;
let baseUrl: string;
let loaded: boolean;
let uiTrusted: boolean;
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-internal-route-'));
  // send 默认 ignore 点目录段；真实 web 数据目录是 ~/.code-agent[-dev]。
  pluginsDir = path.join(tmpRoot, '.data-dir', 'plugins');
  const internalPluginRoot = path.join(
    pluginsDir,
    'evaluation-center',
    'packages',
    '1.0.0-fixture',
  );
  const rendererDir = path.join(internalPluginRoot, 'dist', 'renderer');
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, 'index.js'), 'window.TEST_PLUGIN = true;', 'utf8');
  await fs.writeFile(path.join(internalPluginRoot, 'dist', 'secret.js'), 'DO-NOT-SERVE', 'utf8');
  const uiRendererDir = path.join(pluginsDir, 'test-ui', 'dist', 'renderer');
  await fs.mkdir(uiRendererDir, { recursive: true });
  await fs.writeFile(path.join(uiRendererDir, 'index.js'), 'window.TEST_THIRD_PARTY_UI = true;', 'utf8');
  await fs.writeFile(path.join(uiRendererDir, 'index.css'), '.test-third-party-ui {}', 'utf8');
  await fs.writeFile(path.join(pluginsDir, 'test-ui', 'dist', 'secret.js'), 'DO-NOT-SERVE-UI', 'utf8');
  loaded = true;
  uiTrusted = true;
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
    rootPath: internalPluginRoot,
    state: 'active',
    registeredTools: [],
  };
  const uiPlugin: LoadedPlugin = {
    manifest: {
      id: 'test-ui',
      name: 'test-ui',
      version: '1.0.0',
      main: 'index.js',
      surfaces: ['ui'],
      uiSlots: ['workspace.page'],
      pluginUi: {
        sdkVersion: { renderer: INTERNAL_SDK_VERSION.renderer },
        rendererEntry: 'dist/renderer/index.js',
        rendererStyles: 'dist/renderer/index.css',
      },
    },
    rootPath: path.join(pluginsDir, 'test-ui'),
    state: 'active',
    registeredTools: [],
  };
  const app = express();
  app.use(createInternalFeaturesRouter({
    runtime: { isLoaded: () => loaded, loadedHash: () => loaded ? 'fixture-hash' : undefined },
    registry: {
      getPlugin: (id) => id === plugin.manifest.id
        ? plugin
        : id === uiPlugin.manifest.id ? uiPlugin : undefined,
    },
    pluginsDir,
    verifyPluginTrust: async () => {
      if (!uiTrusted) throw new Error('untrusted');
      return {
        packageHash: 'fixture-hash',
        sourceTrust: { level: 'unsigned' as const, reason: 'fixture' },
      };
    },
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
  await fs.rm(tmpRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createInternalFeaturesRouter', () => {
  it('serves renderer bytes when the plugin lives under a dotted data-dir segment', async () => {
    expect(pluginsDir.includes(`${path.sep}.data-dir${path.sep}`)).toBe(true);

    const internalExpected = 'window.TEST_PLUGIN = true;';
    const internal = await fetch(`${baseUrl}/internal-features/evaluation-center/index.js`);
    expect(internal.status).toBe(200);
    expect(await internal.text()).toBe(internalExpected);

    const uiExpected = 'window.TEST_THIRD_PARTY_UI = true;';
    const ui = await fetch(`${baseUrl}/plugin-ui/test-ui/index.js`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toBe(uiExpected);
  });

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

  it('serves verified third-party UI files through the distinct same-origin path', async () => {
    const ok = await fetch(`${baseUrl}/plugin-ui/test-ui/index.js?v=fixture`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('TEST_THIRD_PARTY_UI');
    expect(ok.headers.get('cache-control')).toBe('no-cache');

    const traversal = await fetch(`${baseUrl}/plugin-ui/test-ui/..%2Fsecret.js`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('DO-NOT-SERVE-UI');

    uiTrusted = false;
    expect((await fetch(`${baseUrl}/plugin-ui/test-ui/index.js`)).status).toBe(404);
  });
});
