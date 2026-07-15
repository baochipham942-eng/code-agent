import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneEnvelope } from '../../src/shared/contract/controlPlane';
import {
  getRuntimeAssetUpdateInfoFromManifest,
  UpdateService,
  type UpdateInfo,
} from '../../src/host/services/cloud/updateService';
import type { RuntimeAssetsManifest } from '../../src/host/runtime/runtimeAssetInstaller';
import { verifyControlPlaneEnvelope } from '../../src/host/services/cloud/controlPlaneTrust';
import { createControlPlaneEnvelope } from '../../vercel-api/lib/controlPlaneEnvelope';

const tempRoots: string[] = [];

function createKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-runtime-manifest-signing-'));
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

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createRuntimeRoot(root: string): string {
  const runtimeRoot = path.join(root, 'runtime-root');
  writeFile(path.join(runtimeRoot, 'node_modules/onnxruntime-node/package.json'), '{"name":"onnxruntime-node"}');
  writeFile(path.join(runtimeRoot, 'node_modules/onnxruntime-node/dist/index.js'), 'module.exports = {};');
  writeFile(path.join(runtimeRoot, 'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime.node'), 'native');
  writeFile(path.join(runtimeRoot, 'node_modules/onnxruntime-common/package.json'), '{"name":"onnxruntime-common"}');
  writeFile(path.join(runtimeRoot, 'node_modules/onnxruntime-common/dist/cjs/index.js'), 'module.exports = {};');
  writeFile(path.join(runtimeRoot, 'node_modules/avr-vad/dist/silero_vad_v5.onnx'), 'model');
  return runtimeRoot;
}

function buildSignedManifest(root: string, keys: ReturnType<typeof createKeyPair>) {
  const runtimeRoot = createRuntimeRoot(root);
  const outputDir = path.join(root, 'remote');
  execFileSync('node', [
    path.join(process.cwd(), 'scripts/build-runtime-assets.mjs'),
    '--root', runtimeRoot,
    '--output-dir', outputDir,
    '--app-version', '0.16.79',
    '--platform', 'darwin-arm64',
    '--asset', 'onnxruntime-vad',
    '--manifest-name', 'manifest.json',
    '--archive-base-url', 'https://cdn.example.com/runtime-assets/',
    '--skip-security-scan',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_PLANE_PRIVATE_KEY: keys.privateKeyPem,
      CONTROL_PLANE_KEY_ID: 'runtime-assets-test-key',
      CONTROL_PLANE_TTL_SECONDS: '3600',
    },
    stdio: 'pipe',
  });

  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const envelope = JSON.parse(manifestText) as ControlPlaneEnvelope<RuntimeAssetsManifest>;
  const manifest = envelope.payload;
  const archiveFileName = path.basename(manifest.assets[0]!.archiveFile);
  const builtArchivePath = path.join(outputDir, manifest.assets[0]!.id, archiveFileName);
  const remoteArchivePath = path.join(outputDir, archiveFileName);
  fs.copyFileSync(builtArchivePath, remoteArchivePath);

  return {
    outputDir,
    manifestPath,
    manifestText,
    manifestSha256: sha256Text(manifestText),
    envelope,
    manifest,
    archivePath: remoteArchivePath,
  };
}

function makeUpdateService(remote: {
  manifestText: string;
  manifestPath: string;
  archivePath: string;
  manifestSha256: string;
}) {
  const service = Object.create(UpdateService.prototype) as UpdateService & {
    cachedUpdateInfo: UpdateInfo;
    isDownloading: boolean;
    httpGet: (url: string) => Promise<string>;
    downloadFile: (url: string, destPath: string) => Promise<string>;
    resolveRuntimeAssetsUpdateInfo: (
      metadata: { manifestUrl?: string; manifestSha256?: string },
    ) => Promise<UpdateInfo['runtimeAssets']>;
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
  service.httpGet = vi.fn(async () => remote.manifestText);
  service.downloadFile = vi.fn(async (url: string, destPath: string) => {
    const source = url.endsWith('/manifest.json') ? remote.manifestPath : remote.archivePath;
    mkdirp(path.dirname(destPath));
    fs.copyFileSync(source, destPath);
    return sha256File(destPath);
  });
  return service;
}

async function withPublicKeys(keys: ReturnType<typeof createKeyPair>, run: () => Promise<void> | void) {
  const previousJson = process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
  try {
    process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = JSON.stringify({
      'runtime-assets-test-key': keys.publicKeyPem,
    });
    await run();
  } finally {
    if (previousJson === undefined) {
      delete process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS;
    } else {
      process.env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS = previousJson;
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime assets manifest signing', () => {
  it('verifies and installs a manifest signed by the build path', async () => {
    const root = makeTempRoot();
    const keys = createKeyPair();
    const remote = buildSignedManifest(root, keys);

    expect(Date.parse(remote.envelope.expiresAt) - Date.parse(remote.envelope.issuedAt!))
      .toBe(10 * 365 * 24 * 60 * 60 * 1000);

    await withPublicKeys(keys, async () => {
      const service = makeUpdateService(remote);
      const info = await service.resolveRuntimeAssetsUpdateInfo({
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: remote.manifestSha256,
      });

      expect(info).toMatchObject({
        hasUpdate: true,
        assets: [{ id: 'onnxruntime-vad', installed: false }],
      });

      const result = await service.prepareRuntimeAssets(path.join(root, 'runtime-install'));

      expect(result.installed).toHaveLength(1);
      expect(result.installed[0]?.assetId).toBe('onnxruntime-vad');
      expect(fs.existsSync(path.join(result.installed[0]!.root, 'node_modules/onnxruntime-node'))).toBe(true);
      expect(service.cachedUpdateInfo.runtimeAssets?.hasUpdate).toBe(false);
    });
  });

  it('rejects an unsigned manifest even when manifestSha256 matches the bytes', async () => {
    const root = makeTempRoot();
    const keys = createKeyPair();
    const remote = buildSignedManifest(root, keys);
    const plainManifestText = `${JSON.stringify(remote.manifest, null, 2)}\n`;
    const plainManifestPath = path.join(root, 'remote', 'unsigned-manifest.json');
    fs.writeFileSync(plainManifestPath, plainManifestText);
    const unsignedRemote = {
      ...remote,
      manifestText: plainManifestText,
      manifestPath: plainManifestPath,
      manifestSha256: sha256Text(plainManifestText),
    };

    await withPublicKeys(keys, async () => {
      const service = makeUpdateService(unsignedRemote);
      const info = await service.resolveRuntimeAssetsUpdateInfo({
        manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
        manifestSha256: unsignedRemote.manifestSha256,
      });

      expect(info).toMatchObject({ hasUpdate: false, assets: [] });
      await expect(service.prepareRuntimeAssets(path.join(root, 'runtime-install'))).rejects.toThrow(
        /runtime assets manifest/i,
      );
      expect(fs.existsSync(path.join(root, 'runtime-install/runtime/onnxruntime-vad'))).toBe(false);
    });
  });

  it('rejects a manifest envelope with the wrong control-plane kind', async () => {
    const root = makeTempRoot();
    const keys = createKeyPair();
    const remote = buildSignedManifest(root, keys);
    const wrongKindEnvelope = createControlPlaneEnvelope({
      kind: 'cloud_config',
      payload: remote.manifest,
      keyId: 'runtime-assets-test-key',
      privateKey: keys.privateKeyPem,
      issuedAt: '2026-05-22T00:00:00.000Z',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });
    const wrongKindText = `${JSON.stringify(wrongKindEnvelope, null, 2)}\n`;
    const wrongKindPath = path.join(root, 'remote', 'wrong-kind-manifest.json');
    fs.writeFileSync(wrongKindPath, wrongKindText);

    await withPublicKeys(keys, async () => {
      const service = makeUpdateService({
        ...remote,
        manifestText: wrongKindText,
        manifestPath: wrongKindPath,
        manifestSha256: sha256Text(wrongKindText),
      });

      await expect(service.prepareRuntimeAssets(path.join(root, 'runtime-install'))).rejects.toThrow(
        /runtime assets manifest/i,
      );
      expect(fs.existsSync(path.join(root, 'runtime-install/runtime/onnxruntime-vad'))).toBe(false);
    });
  });

  it('round-trips build output through controlPlaneTrust', () => {
    const root = makeTempRoot();
    const keys = createKeyPair();
    const remote = buildSignedManifest(root, keys);

    const result = verifyControlPlaneEnvelope<RuntimeAssetsManifest>(remote.envelope, {
      kind: 'runtime_assets_manifest',
      publicKeys: {
        'runtime-assets-test-key': keys.publicKeyPem,
      },
      requireSignature: true,
      now: Date.parse('2026-05-22T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      trusted: true,
      keyId: 'runtime-assets-test-key',
      diagnostics: [],
    });
    expect(result.payload).toMatchObject({
      kind: 'agent_neo_runtime_assets',
      assets: [{ id: 'onnxruntime-vad' }],
    });
    expect(getRuntimeAssetUpdateInfoFromManifest(result.payload!, null, {
      manifestUrl: 'https://cdn.example.com/runtime-assets/manifest.json',
      manifestSha256: remote.manifestSha256,
    }).hasUpdate).toBe(true);
  });
});
