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
} from '../../../../src/main/services/cloud/updateService';
import type { RuntimeAssetsManifest } from '../../../../src/main/runtime/runtimeAssetInstaller';
import { createControlPlaneEnvelope } from '../../../../vercel-api/lib/controlPlaneEnvelope';

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

function createRuntimePackage(root: string): {
  manifest: RuntimeAssetsManifest;
  manifestPath: string;
  manifestSha256: string;
  archivePath: string;
} {
  const stagingDir = path.join(root, 'staging');
  writeFile(path.join(stagingDir, 'node_modules', 'onnxruntime-node', 'index.js'), 'module.exports = {};');
  writeFile(path.join(stagingDir, 'node_modules', 'avr-vad', 'dist', 'silero_vad_v5.onnx'), 'model');

  const archivePath = path.join(root, 'remote', 'onnxruntime-vad.tar.gz');
  mkdirp(path.dirname(archivePath));
  execFileSync('tar', ['-czf', archivePath, '-C', stagingDir, '.']);

  const expandedSha256 = treeHash(stagingDir);
  const manifest: RuntimeAssetsManifest = {
    schemaVersion: 1,
    kind: 'agent_neo_runtime_assets',
    generatedAt: '2026-05-22T00:00:00.000Z',
    appVersion: '0.16.79',
    platform: 'darwin-arm64',
    assets: [{
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
    }],
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
    const service = Object.create(UpdateService.prototype) as UpdateService & {
      cachedUpdateInfo: UpdateInfo;
      isDownloading: boolean;
      downloadFile: (url: string, destPath: string) => Promise<string>;
    };
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
    service.downloadFile = vi.fn(async (url: string, destPath: string) => {
      const source = url.endsWith('/manifest.json') ? remote.manifestPath : remote.archivePath;
      mkdirp(path.dirname(destPath));
      fs.copyFileSync(source, destPath);
      return sha256File(destPath);
    });

    const result = await service.prepareRuntimeAssets(runtimeBaseDir);

    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]?.assetId).toBe('onnxruntime-vad');
    expect(fs.existsSync(path.join(result.installed[0]!.root, 'node_modules', 'onnxruntime-node'))).toBe(true);
    expect(service.cachedUpdateInfo.runtimeAssets?.hasUpdate).toBe(false);
    expect(service.cachedUpdateInfo.runtimeAssets?.assets?.[0]?.installed).toBe(true);
  });
});
