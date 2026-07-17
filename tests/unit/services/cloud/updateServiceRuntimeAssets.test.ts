import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRuntimeAssetUpdateInfoFromManifest,
  UpdateService,
  type UpdateInfo,
} from '../../../../src/host/services/cloud/updateService';
import type { RuntimeAssetsManifest } from '../../../../src/host/runtime/runtimeAssetInstaller';
import { readActiveRuntimeAssets } from '../../../../src/host/runtime/runtimeAssetInstaller';
import { createControlPlaneEnvelope } from '../../../../vercel-api/lib/controlPlaneEnvelope';

// `cachedUpdateInfo`/`isDownloading`/`downloadFile`/`runtimeAssetPreparations`/`runtimeAssetQueue`
// are private on UpdateService. Intersecting `UpdateService & {...}` collides with the private
// members and TS reduces the type to `never`, so this harness type stands alone (not intersected)
// and only pulls the two public methods through indexed access to stay in sync with the class.
type UpdateServiceRuntimeHarness = {
  cachedUpdateInfo: UpdateInfo;
  isDownloading: boolean;
  downloadFile: (
    url: string,
    destPath: string,
    onProgress?: (progress: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => void,
  ) => Promise<string>;
  runtimeAssetPreparations: Map<string, Promise<unknown>>;
  runtimeAssetQueue: Promise<void>;
  prepareRuntimeAsset: UpdateService['prepareRuntimeAsset'];
  getRuntimeAssetPreparationStatus: UpdateService['getRuntimeAssetPreparationStatus'];
};

const tempRoots: string[] = [];

const TEST_CONTROL_PLANE_KEY_ID = 'runtime-assets-test-key';
const testControlPlaneKeyPair = crypto.generateKeyPairSync('ed25519');
const testControlPlanePrivateKeyPem = testControlPlaneKeyPair.privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const testControlPlanePublicKeyPem = testControlPlaneKeyPair.publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const previousControlPlanePublicKeysEnv = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-update-runtime-'));
  tempRoots.push(root);
  return root;
}

function mkdirp(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function writeFile(targetPath: string, content: string): void {
  mkdirp(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function walkFiles(rootDir: string): Array<{ path: string; relativePath: string; bytes: number }> {
  const files: Array<{ path: string; relativePath: string; bytes: number }> = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        files.push({
          path: fullPath,
          relativePath: toPosix(path.relative(rootDir, fullPath)),
          bytes: stat.size,
        });
      }
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

function treeHash(rootDir: string): string {
  const hash = crypto.createHash('sha256');
  for (const file of walkFiles(rootDir)) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(sha256File(file.path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createRuntimePackage(root: string, includePlaywright = false): {
  manifest: RuntimeAssetsManifest;
  manifestPath: string;
  manifestSha256: string;
  archivePath: string;
  archivePaths: Record<string, string>;
} {
  const stagingDir = path.join(root, 'staging');
  writeFile(path.join(stagingDir, 'node_modules', 'onnxruntime-node', 'index.js'), 'module.exports = {};');
  writeFile(path.join(stagingDir, 'node_modules', 'avr-vad', 'dist', 'silero_vad_v5.onnx'), 'model');

  const archivePath = path.join(root, 'remote', 'onnxruntime-vad.tar.gz');
  mkdirp(path.dirname(archivePath));
  execFileSync('tar', ['-czf', archivePath, '-C', stagingDir, '.']);

  const expandedSha256 = treeHash(stagingDir);
  const assets: RuntimeAssetsManifest['assets'] = [{
    id: 'onnxruntime-vad',
    archiveFile: 'onnxruntime-vad.tar.gz',
    archiveSha256: sha256File(archivePath),
    expandedSha256,
    archiveBytes: fs.statSync(archivePath).size,
    groups: ['node_modules/onnxruntime-node', 'node_modules/avr-vad'],
    nodeModules: ['onnxruntime-node', 'avr-vad'],
    install: {
      root: `runtime/onnxruntime-vad/${expandedSha256}`,
    },
  }];
  const archivePaths: Record<string, string> = {
    'onnxruntime-vad.tar.gz': archivePath,
  };

  if (includePlaywright) {
    const playwrightStagingDir = path.join(root, 'staging-playwright');
    writeFile(path.join(playwrightStagingDir, 'node_modules', 'playwright', 'index.js'), 'module.exports = { chromium: {} };');
    const playwrightArchivePath = path.join(root, 'remote', 'playwright-browser-runtime.tar.gz');
    execFileSync('tar', ['-czf', playwrightArchivePath, '-C', playwrightStagingDir, '.']);
    const playwrightExpandedSha256 = treeHash(playwrightStagingDir);
    assets.push({
      id: 'playwright-browser-runtime',
      archiveFile: 'playwright-browser-runtime.tar.gz',
      archiveSha256: sha256File(playwrightArchivePath),
      expandedSha256: playwrightExpandedSha256,
      archiveBytes: fs.statSync(playwrightArchivePath).size,
      groups: ['node_modules/playwright'],
      nodeModules: ['playwright'],
      install: {
        root: `runtime/playwright-browser-runtime/${playwrightExpandedSha256}`,
      },
    });
    archivePaths['playwright-browser-runtime.tar.gz'] = playwrightArchivePath;
  }

  const manifest: RuntimeAssetsManifest = {
    schemaVersion: 1,
    kind: 'agent_neo_runtime_assets',
    generatedAt: '2026-05-22T00:00:00.000Z',
    appVersion: '0.16.79',
    platform: 'darwin-arm64',
    assets,
  };
  const envelope = createControlPlaneEnvelope({
    kind: 'runtime_assets_manifest',
    payload: manifest,
    keyId: TEST_CONTROL_PLANE_KEY_ID,
    privateKey: testControlPlanePrivateKeyPem,
    ttlSeconds: 3600,
  });
  process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = JSON.stringify({
    [TEST_CONTROL_PLANE_KEY_ID]: testControlPlanePublicKeyPem,
  });
  const manifestPath = path.join(root, 'remote', 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    archivePath,
    archivePaths,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (previousControlPlanePublicKeysEnv === undefined) {
    delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
  } else {
    process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = previousControlPlanePublicKeysEnv;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('UpdateService runtime assets', () => {
  it('derives runtime asset update state from manifest and active installs', () => {
    const root = makeTempRoot();
    const { manifest } = createRuntimePackage(root);

    expect(getRuntimeAssetUpdateInfoFromManifest(manifest, null, {
      manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
      manifestSha256: 'a'.repeat(64),
    })).toMatchObject({
      hasUpdate: true,
      assets: [{ id: 'onnxruntime-vad', installed: false }],
    });

    expect(getRuntimeAssetUpdateInfoFromManifest(manifest, {
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'onnxruntime-vad': {
          assetId: 'onnxruntime-vad',
          root: '/tmp/runtime',
          expandedSha256: manifest.assets[0]!.expandedSha256,
          archiveSha256: manifest.assets[0]!.archiveSha256!,
          archiveFile: '/tmp/runtime.tar.gz',
          groups: [],
          nodeModules: [],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
      },
    }, {
      manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
      manifestSha256: 'a'.repeat(64),
    })).toMatchObject({
      hasUpdate: false,
      assets: [{ id: 'onnxruntime-vad', installed: true }],
    });
  });

  it('downloads, verifies, and installs runtime assets from cached metadata', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const remote = createRuntimePackage(root);
    const service = Object.create(UpdateService.prototype) as unknown as UpdateServiceRuntimeHarness;
    service.cachedUpdateInfo = {
      hasUpdate: false,
      currentVersion: '0.16.79',
      runtimeAssets: {
        hasUpdate: true,
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: remote.manifestSha256,
      },
    };
    service.isDownloading = false;
    service.runtimeAssetPreparations = new Map();
    service.runtimeAssetQueue = Promise.resolve();
    service.downloadFile = vi.fn(async (url: string, destPath: string) => {
      const source = url.endsWith('/manifest.json') ? remote.manifestPath : remote.archivePath;
      mkdirp(path.dirname(destPath));
      fs.copyFileSync(source, destPath);
      return sha256File(destPath);
    });

    const result = await service.prepareRuntimeAsset('onnxruntime-vad', runtimeBaseDir);

    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]?.assetId).toBe('onnxruntime-vad');
    expect(fs.existsSync(path.join(result.installed[0]!.root, 'node_modules', 'onnxruntime-node'))).toBe(true);
    expect(service.cachedUpdateInfo.runtimeAssets?.hasUpdate).toBe(false);
    expect(service.cachedUpdateInfo.runtimeAssets?.assets?.[0]?.installed).toBe(true);
    expect(service.getRuntimeAssetPreparationStatus()).toMatchObject({
      assetId: 'onnxruntime-vad',
      phase: 'completed',
      percent: 100,
    });
  });

  it('keeps packaged first-use installs asset-scoped, reports progress, and retries a failed browser install', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'fresh-profile', 'runtime');
    const remote = createRuntimePackage(root, true);
    const observedProgress: Array<ReturnType<UpdateService['getRuntimeAssetPreparationStatus']>> = [];
    let failPlaywrightOnce = true;
    const service = Object.create(UpdateService.prototype) as unknown as UpdateServiceRuntimeHarness;
    service.cachedUpdateInfo = {
      hasUpdate: false,
      currentVersion: '0.26.5',
      runtimeAssets: {
        hasUpdate: true,
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: remote.manifestSha256,
        assets: remote.manifest.assets.map((asset) => ({ id: asset.id, installed: false })),
      },
    };
    service.isDownloading = false;
    service.runtimeAssetPreparations = new Map();
    service.runtimeAssetQueue = Promise.resolve();
    service.downloadFile = vi.fn(async (url, destPath, onProgress) => {
      const fileName = path.basename(new URL(url).pathname);
      if (fileName === 'playwright-browser-runtime.tar.gz' && failPlaywrightOnce) {
        failPlaywrightOnce = false;
        throw new Error('simulated interrupted download');
      }
      const source = fileName === 'manifest.json'
        ? remote.manifestPath
        : remote.archivePaths[fileName];
      if (!source) throw new Error(`Unexpected runtime asset URL: ${url}`);
      mkdirp(path.dirname(destPath));
      fs.copyFileSync(source, destPath);
      if (fileName !== 'manifest.json') {
        onProgress?.({ percent: 50, transferred: 5, total: 10, bytesPerSecond: 5 });
        observedProgress.push(service.getRuntimeAssetPreparationStatus());
      }
      return sha256File(destPath);
    });

    expect(await readActiveRuntimeAssets(runtimeBaseDir)).toBeNull();
    expect(service.cachedUpdateInfo.runtimeAssets?.assets).toEqual([
      expect.objectContaining({ id: 'onnxruntime-vad', installed: false }),
      expect.objectContaining({ id: 'playwright-browser-runtime', installed: false }),
    ]);

    const audioResult = await service.prepareRuntimeAsset('onnxruntime-vad', runtimeBaseDir);
    expect(audioResult.installed.map((asset) => asset.assetId)).toEqual(['onnxruntime-vad']);
    expect(Object.keys((await readActiveRuntimeAssets(runtimeBaseDir))?.assets ?? {})).toEqual(['onnxruntime-vad']);
    expect(service.cachedUpdateInfo.runtimeAssets?.assets).toEqual([
      expect.objectContaining({ id: 'onnxruntime-vad', installed: true }),
      expect.objectContaining({ id: 'playwright-browser-runtime', installed: false }),
    ]);

    await expect(service.prepareRuntimeAsset('playwright-browser-runtime', runtimeBaseDir))
      .rejects.toThrow('simulated interrupted download');
    expect(Object.keys((await readActiveRuntimeAssets(runtimeBaseDir))?.assets ?? {})).toEqual(['onnxruntime-vad']);
    expect(service.getRuntimeAssetPreparationStatus()).toMatchObject({
      assetId: 'playwright-browser-runtime',
      phase: 'failed',
    });

    const browserResult = await service.prepareRuntimeAsset('playwright-browser-runtime', runtimeBaseDir);
    expect(browserResult.installed.map((asset) => asset.assetId)).toEqual(['playwright-browser-runtime']);
    expect(Object.keys((await readActiveRuntimeAssets(runtimeBaseDir))?.assets ?? {}).sort()).toEqual([
      'onnxruntime-vad',
      'playwright-browser-runtime',
    ]);
    expect(observedProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'downloading', percent: 50 }),
    ]));
    expect(fs.existsSync(path.join(runtimeBaseDir, 'active.json'))).toBe(true);
  });
});
