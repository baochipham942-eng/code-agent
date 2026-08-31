import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InternalFeatureHostRuntime } from '../../../src/host/internalFeatures/internalFeatureHostRuntime';
import { INTERNAL_SDK_VERSION } from '../../../src/host/internalFeatures/internalSdkVersion';
import type { LoadedPlugin, PluginManifest } from '../../../src/host/plugins/types';
import { hashPluginPackage, writePluginApprovalReceipt } from '../../../src/host/plugins/pluginApprovalReceipt';
import type { ipcHost } from '../../../src/host/platform';

let tempRoot: string;

function internalManifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'runtime fixture',
    main: 'index.js',
    permissions: [],
    surfaces: ['internal-feature'],
    distribution: 'internal',
    adminOnly: true,
    internalFeature: {
      id,
      label: '评测中心',
      sdkVersion: { host: INTERNAL_SDK_VERSION.host, renderer: 'pending' },
      rendererEntry: 'dist/renderer/index.js',
      rendererStyles: 'dist/renderer/index.css',
      hostEntry: 'dist/host/index.cjs',
    },
  };
}

async function writeRuntimePlugin(source: string): Promise<LoadedPlugin> {
  const rootPath = path.join(tempRoot, `plugin-${Math.random().toString(16).slice(2)}`);
  const manifest = internalManifest('evaluation-center');
  await fs.mkdir(path.join(rootPath, 'dist/host'), { recursive: true });
  await fs.writeFile(path.join(rootPath, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(rootPath, 'dist/host/index.cjs'), source, 'utf8');
  const packageHash = await hashPluginPackage(rootPath);
  await writePluginApprovalReceipt(rootPath, {
    pluginId: manifest.id,
    packageHash,
    permissions: [],
    sandboxValidatedAt: 1,
    approvedAt: 2,
  });
  return { manifest, rootPath, state: 'inactive', registeredTools: [] };
}

function createTestIpc(): { handlers: Map<string, unknown>; ipcMain: typeof ipcHost } {
  const handlers = new Map<string, unknown>();
  const ipcMain: typeof ipcHost = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    on: () => undefined,
    once: () => undefined,
    removeHandler: (channel) => { handlers.delete(channel); },
    removeAllListeners: () => undefined,
  };
  return { handlers, ipcMain };
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-internal-host-runtime-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('InternalFeatureHostRuntime', () => {
  it('loads a host entry and unload calls deactivate to remove its handler', async () => {
    const plugin = await writeRuntimePlugin(`
module.exports.activate = ({ ipcMain }) => {
  ipcMain.handle('test:ping', () => 'pong');
  return { deactivate() { ipcMain.removeHandler('test:ping'); } };
};
`);
    const { handlers, ipcMain } = createTestIpc();
    const runtime = new InternalFeatureHostRuntime({
      registry: { getPlugins: () => [plugin] },
      ipcMain,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await runtime.load(plugin);
    expect(handlers.has('test:ping')).toBe(true);
    expect(runtime.isLoaded(plugin.manifest.id)).toBe(true);

    await runtime.unload(plugin.manifest.id);
    expect(handlers.has('test:ping')).toBe(false);
    expect(runtime.isLoaded(plugin.manifest.id)).toBe(false);
  });

  it('does not load an internal plugin outside the first-party allowlist', async () => {
    const plugin: LoadedPlugin = {
      manifest: internalManifest('not-allowlisted'),
      rootPath: path.join(tempRoot, 'not-allowlisted'),
      state: 'active',
      registeredTools: [],
    };
    const { ipcMain } = createTestIpc();
    const runtime = new InternalFeatureHostRuntime({
      registry: { getPlugins: () => [plugin] },
      ipcMain,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await runtime.load(plugin);

    expect(runtime.isLoaded(plugin.manifest.id)).toBe(false);
    expect(plugin.state).not.toBe('active');
  });

  it('keeps the original activation error in plugin state and lifecycle', async () => {
    const plugin = await writeRuntimePlugin(`
module.exports.activate = () => { throw new Error('host boom'); };
`);
    const lifecycle: Array<{ action: string; detail?: string }> = [];
    const { ipcMain } = createTestIpc();
    const runtime = new InternalFeatureHostRuntime({
      registry: { getPlugins: () => [plugin] },
      ipcMain,
      lifecycle: (_id, action, detail) => { lifecycle.push({ action, detail }); },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await expect(runtime.load(plugin)).rejects.toThrow('host boom');
    expect(plugin).toMatchObject({ state: 'error', error: 'host boom' });
    expect(lifecycle).toContainEqual({ action: 'failed', detail: 'host boom' });
  });
});
