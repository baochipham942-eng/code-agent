import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InternalFeatureHostRuntime } from '../../../src/host/internalFeatures/internalFeatureHostRuntime';
import { INTERNAL_SDK_VERSION } from '../../../src/host/internalFeatures/internalSdkVersion';
import type { LoadedPlugin, PluginManifest } from '../../../src/host/plugins/types';
import {
  hashPluginPackage,
  PLUGIN_PACKAGE_SIGNATURE_FILE,
  writePluginApprovalReceipt,
} from '../../../src/host/plugins/pluginApprovalReceipt';
import { verifyInstalledPluginTrust } from '../../../src/host/plugins/pluginPackageTrust';
import type { ipcHost } from '../../../src/host/platform';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../src/host/services/cloud/controlPlaneTrust';
import type { ControlPlaneEnvelope } from '../../../src/shared/contract/controlPlane';

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
      sdkVersion: INTERNAL_SDK_VERSION,
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

async function signRuntimePlugin(plugin: LoadedPlugin, privateKey: KeyObject, keyId: string): Promise<void> {
  const payload = {
    schemaVersion: 1 as const,
    pluginId: plugin.manifest.id,
    packageHash: await hashPluginPackage(plugin.rootPath),
  };
  const envelope: ControlPlaneEnvelope<typeof payload> = {
    schemaVersion: 1,
    kind: 'plugin_package',
    expiresAt: '2099-01-01T00:00:00.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId,
    payload,
  };
  envelope.signature = sign(
    null,
    Buffer.from(buildControlPlaneSigningPayload(envelope)),
    privateKey,
  ).toString('base64');
  await fs.writeFile(
    path.join(plugin.rootPath, PLUGIN_PACKAGE_SIGNATURE_FILE),
    JSON.stringify(envelope),
    'utf8',
  );
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

  it('loadInstalled blocks a previously valid plugin after its author is revoked', async () => {
    const plugin = await writeRuntimePlugin(`
module.exports.activate = () => ({ deactivate() {} });
`);
    const keyId = 'revoked-author';
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await signRuntimePlugin(plugin, keys.privateKey, keyId);
    const { ipcMain } = createTestIpc();
    const runtime = new InternalFeatureHostRuntime({
      registry: { getPlugins: () => [plugin] },
      ipcMain,
      verifyPluginTrust: (rootPath, value) => verifyInstalledPluginTrust(rootPath, value, {
        publicKeys: { [keyId]: publicKey },
        revokedIds: new Set([`plugin-key:${keyId}`]),
      }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await runtime.loadInstalled();

    expect(runtime.isLoaded(plugin.manifest.id)).toBe(false);
    expect(plugin).toMatchObject({
      state: 'error',
      error: '这个插件的发布者已被吊销，插件已停止装载，请联系管理员',
    });
  });
});
