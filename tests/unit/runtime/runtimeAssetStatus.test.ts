import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeAssetsStatus } from '../../../src/main/runtime/runtimeAssetStatus';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-runtime-status-'));
  tempRoots.push(root);
  return root;
}

function mkdirp(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runtimeAssetStatus', () => {
  it('reports installed managed assets when active runtime modules exist', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const managedRoot = mkdirp(path.join(runtimeBaseDir, 'onnxruntime-vad', 'hash'));
    const browserManagedRoot = mkdirp(path.join(runtimeBaseDir, 'playwright-browser-runtime', 'hash'));
    const sharpManagedRoot = mkdirp(path.join(runtimeBaseDir, 'sharp-image-runtime', 'hash'));
    mkdirp(path.join(managedRoot, 'node_modules', 'onnxruntime-node'));
    mkdirp(path.join(managedRoot, 'node_modules', 'avr-vad'));
    mkdirp(path.join(browserManagedRoot, 'node_modules', 'playwright'));
    mkdirp(path.join(browserManagedRoot, 'node_modules', 'playwright-core'));
    mkdirp(path.join(sharpManagedRoot, 'node_modules', 'sharp'));
    mkdirp(path.join(sharpManagedRoot, 'node_modules', '@img', 'colour'));
    mkdirp(path.join(sharpManagedRoot, 'node_modules', '@img', 'sharp-darwin-arm64'));
    mkdirp(path.join(sharpManagedRoot, 'node_modules', '@img', 'sharp-libvips-darwin-arm64'));
    mkdirp(path.join(sharpManagedRoot, 'node_modules', 'detect-libc'));
    mkdirp(runtimeBaseDir);
    fs.writeFileSync(path.join(runtimeBaseDir, 'active.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'onnxruntime-vad': {
          assetId: 'onnxruntime-vad',
          root: managedRoot,
          expandedSha256: 'hash',
          archiveSha256: 'a'.repeat(64),
          archiveFile: '/tmp/runtime.tar.gz',
          groups: [],
          nodeModules: ['onnxruntime-node', 'avr-vad'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
        'playwright-browser-runtime': {
          assetId: 'playwright-browser-runtime',
          root: browserManagedRoot,
          expandedSha256: 'hash',
          archiveSha256: 'b'.repeat(64),
          archiveFile: '/tmp/playwright.tar.gz',
          groups: [],
          nodeModules: ['playwright', 'playwright-core'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
        'sharp-image-runtime': {
          assetId: 'sharp-image-runtime',
          root: sharpManagedRoot,
          expandedSha256: 'hash',
          archiveSha256: 'c'.repeat(64),
          archiveFile: '/tmp/sharp.tar.gz',
          groups: [],
          nodeModules: [
            'sharp',
            '@img/colour',
            '@img/sharp-darwin-arm64',
            '@img/sharp-libvips-darwin-arm64',
            'detect-libc',
          ],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
      },
    }));

    const status = await getRuntimeAssetsStatus({ runtimeBaseDir });
    expect(status.summary).toEqual({ installed: 3, bundledFallback: 0, missing: 0 });
    expect(status.assets.every((asset) => asset.nodeModules.every((moduleStatus) => moduleStatus.source === 'managed'))).toBe(true);
    expect(status.assets.find((asset) => asset.id === 'sharp-image-runtime')).toMatchObject({
      delivery: 'bundled',
      state: 'installed',
    });
  });

  it('reports Sharp as bundled fallback while optional browser and audio runtimes are absent', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const bundledRoot = makeTempRoot();
    mkdirp(path.join(bundledRoot, 'node_modules', 'sharp'));
    mkdirp(path.join(bundledRoot, 'node_modules', '@img', 'colour'));
    mkdirp(path.join(bundledRoot, 'node_modules', '@img', 'sharp-darwin-arm64'));
    mkdirp(path.join(bundledRoot, 'node_modules', '@img', 'sharp-libvips-darwin-arm64'));
    mkdirp(path.join(bundledRoot, 'node_modules', 'detect-libc'));

    const status = await getRuntimeAssetsStatus({
      runtimeBaseDir,
      resolverOptions: {
        env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
        cwd: makeTempRoot(),
        dirname: path.join(makeTempRoot(), 'dist', 'web'),
      },
    });

    expect(status.summary).toEqual({ installed: 0, bundledFallback: 1, missing: 2 });
    expect(status.assets.find((asset) => asset.id === 'sharp-image-runtime')).toMatchObject({
      delivery: 'bundled',
      state: 'bundledFallback',
    });
    expect(status.assets.find((asset) => asset.id === 'onnxruntime-vad')).toMatchObject({
      delivery: 'optional',
      state: 'missing',
    });
    expect(status.assets.find((asset) => asset.id === 'playwright-browser-runtime')).toMatchObject({
      delivery: 'optional',
      state: 'missing',
    });
  });

  it('reports missing when managed and bundled pilot modules are absent', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const bundledRoot = makeTempRoot();

    const status = await getRuntimeAssetsStatus({
      runtimeBaseDir,
      resolverOptions: {
        env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
        cwd: makeTempRoot(),
        dirname: path.join(makeTempRoot(), 'dist', 'web'),
      },
    });

    expect(status.summary).toEqual({ installed: 0, bundledFallback: 0, missing: 3 });
    expect(status.assets.every((asset) => asset.state === 'missing')).toBe(true);
    expect(status.assets.every((asset) => asset.nodeModules.every((moduleStatus) => !moduleStatus.exists))).toBe(true);
  });
});
