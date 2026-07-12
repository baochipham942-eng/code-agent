import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeAssetsStatus } from '../../../src/host/runtime/runtimeAssetStatus';

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

function writeExecutable(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function createBundledRegistryResources(root: string): void {
  writeExecutable(path.join(root, 'scripts', 'system-audio-capture'));
  writeExecutable(path.join(root, 'scripts', 'vision-ocr'));
  writeExecutable(path.join(root, 'scripts', 'vision-tagger'));
  writeExecutable(path.join(root, 'scripts', 'uv'));
  writeExecutable(path.join(root, 'scripts', 'rtk'));
  mkdirp(path.join(root, 'scripts', 'Agent Neo Computer Use.app'));
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
    const bundledRoot = makeTempRoot();
    createBundledRegistryResources(bundledRoot);
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

    const status = await getRuntimeAssetsStatus({
      runtimeBaseDir,
      shellVersion: '0.16.120',
      resolverOptions: {
        env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
        cwd: makeTempRoot(),
        dirname: path.join(makeTempRoot(), 'dist', 'web'),
      },
    });
    expect(status.summary.installed).toBe(3);
    expect(status.summary.bundledFallback).toBe(status.assets.length - 3);
    expect(status.summary.missing).toBe(0);
    expect(status.assets.every((asset) => asset.nodeModules.every((moduleStatus) => moduleStatus.source === 'managed'))).toBe(true);
    expect(status.assets.find((asset) => asset.id === 'sharp-image-runtime')).toMatchObject({
      delivery: 'bundled',
      state: 'installed',
    });
    expect(status.assets.find((asset) => asset.id === 'uv')).toMatchObject({
      kind: 'tool-binary',
      registry: expect.objectContaining({
        version: '0.11.16',
        minShellVersion: '0.16.120',
        hashKind: 'pinnedBinarySha256',
        platform: expect.stringMatching(/^(darwin|win32)-/),
      }),
    });
    expect(status.assets.find((asset) => asset.id === 'system-audio-capture')).toMatchObject({
      kind: 'helper-binary',
      registry: expect.objectContaining({
        state: 'bundledFallback',
        source: 'bundled',
        minShellVersion: '0.16.120',
        hashKind: 'fileSha256',
      }),
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
    createBundledRegistryResources(bundledRoot);

    const status = await getRuntimeAssetsStatus({
      runtimeBaseDir,
      shellVersion: '0.16.120',
      resolverOptions: {
        env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
        cwd: makeTempRoot(),
        dirname: path.join(makeTempRoot(), 'dist', 'web'),
      },
    });

    expect(status.summary.installed).toBe(0);
    expect(status.summary.bundledFallback).toBe(status.assets.length - 2);
    expect(status.summary.missing).toBe(2);
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

    expect(status.summary).toEqual({ installed: 0, bundledFallback: 0, missing: status.assets.length, unsupported: 0 });
    expect(status.assets.every((asset) => asset.state === 'missing')).toBe(true);
    expect(status.assets.every((asset) => asset.nodeModules.every((moduleStatus) => !moduleStatus.exists))).toBe(true);
  });

  it('reports arm64-only VAD as unsupported rather than missing on darwin-x64', async () => {
    const root = makeTempRoot();
    const status = await getRuntimeAssetsStatus({
      runtimeBaseDir: path.join(root, 'runtime'),
      platform: 'darwin-x64',
      resolverOptions: {
        env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: makeTempRoot() },
        cwd: makeTempRoot(),
        dirname: path.join(makeTempRoot(), 'dist', 'web'),
      },
    });

    expect(status.assets.find((asset) => asset.id === 'onnxruntime-vad')).toMatchObject({
      state: 'unsupported',
      platform: 'darwin-x64',
      registry: expect.objectContaining({ required: false }),
    });
    expect(status.summary.unsupported).toBe(1);
    expect(status.summary.missing).toBe(status.assets.length - 1);
  });
});
