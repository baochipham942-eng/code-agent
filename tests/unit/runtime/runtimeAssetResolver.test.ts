import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveBundledPath,
  resolveExistingNodeModule,
  resolveExistingResource,
  resolveHelperBinary,
  resolveNodeModule,
  resolveRuntimeRoot,
} from '../../../src/host/runtime/runtimeAssetResolver';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-runtime-resolver-'));
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

describe('runtimeAssetResolver', () => {
  it('prefers managed runtime root over bundled runtime root', () => {
    const managedRoot = makeTempRoot();
    const bundledRoot = makeTempRoot();

    expect(resolveRuntimeRoot({
      env: {
        AGENT_NEO_MANAGED_RUNTIME_ROOT: managedRoot,
        AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot,
      },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBe(managedRoot);
  });

  it('uses bundled runtime root when managed root is not set', () => {
    const bundledRoot = makeTempRoot();

    expect(resolveRuntimeRoot({
      env: {
        AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot,
      },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBe(bundledRoot);
  });

  it('falls back to a Resources/_up_ runtime root with bundled dist assets', () => {
    const resourceDir = makeTempRoot();
    const bundledRoot = mkdirp(path.join(resourceDir, '_up_'));
    mkdirp(path.join(bundledRoot, 'dist', 'web'));

    expect(resolveRuntimeRoot({
      env: {},
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      resourcesPath: resourceDir,
    })).toBe(bundledRoot);
  });

  it('falls back to the dev project root when dist assets are under cwd', () => {
    const projectRoot = makeTempRoot();
    mkdirp(path.join(projectRoot, 'dist', 'renderer'));

    expect(resolveRuntimeRoot({
      env: {},
      cwd: projectRoot,
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      resourcesPath: '',
    })).toBe(projectRoot);
  });

  it('resolves supported bundled asset paths from the selected runtime root', () => {
    const bundledRoot = makeTempRoot();

    const options = {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    };

    expect(resolveBundledPath('dist/web', options)).toBe(path.join(bundledRoot, 'dist', 'web'));
    expect(resolveBundledPath('dist/renderer', options)).toBe(path.join(bundledRoot, 'dist', 'renderer'));
    expect(resolveBundledPath('dist/native', options)).toBe(path.join(bundledRoot, 'dist', 'native'));
  });

  it('resolves declared resource dependencies from runtime roots and resources folders', () => {
    const bundledRoot = makeTempRoot();
    const resourceDir = makeTempRoot();
    const directResource = mkdirp(path.join(bundledRoot, 'resources', 'browser-relay-extension'));
    const packagedResource = mkdirp(path.join(resourceDir, '_up_', 'resources', 'packaged-extension'));

    const options = {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      resourcesPath: resourceDir,
    };

    expect(resolveExistingResource('browser-relay-extension', options)).toBe(directResource);
    expect(resolveExistingResource('resources/packaged-extension', options)).toBe(packagedResource);
    expect(resolveExistingResource('resources/missing-extension', options)).toBeNull();
  });

  it('returns the first existing node module candidate under the runtime root', () => {
    const runtimeRoot = makeTempRoot();
    const modulePath = mkdirp(path.join(runtimeRoot, 'node_modules', 'onnxruntime-node'));
    mkdirp(path.join(runtimeRoot, 'dist', 'native', 'node_modules', 'onnxruntime-node'));

    expect(resolveNodeModule('onnxruntime-node', {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: runtimeRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBe(modulePath);
  });

  it('returns null when an optional node module is not installed anywhere', () => {
    const runtimeRoot = makeTempRoot();

    expect(resolveExistingNodeModule('onnxruntime-node', {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: runtimeRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBeNull();
  });

  it('prefers active managed runtime asset node modules without changing bundled dist paths', () => {
    const bundledRoot = makeTempRoot();
    const userDataPath = makeTempRoot();
    const runtimeBaseDir = mkdirp(path.join(userDataPath, 'runtime'));
    const managedAssetRoot = mkdirp(path.join(runtimeBaseDir, 'onnxruntime-vad', 'a'.repeat(64)));
    const managedModulePath = mkdirp(path.join(managedAssetRoot, 'node_modules', 'onnxruntime-node'));
    mkdirp(path.join(bundledRoot, 'dist', 'web'));
    mkdirp(path.join(bundledRoot, 'node_modules', 'onnxruntime-node'));
    fs.writeFileSync(path.join(runtimeBaseDir, 'active.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'onnxruntime-vad': {
          assetId: 'onnxruntime-vad',
          root: managedAssetRoot,
          expandedSha256: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          archiveFile: '/tmp/onnxruntime-vad.tar.gz',
          groups: ['node_modules/onnxruntime-node'],
          nodeModules: ['onnxruntime-node'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
      },
    }));

    const options = {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      userDataPath,
    };

    expect(resolveNodeModule('onnxruntime-node', options)).toBe(managedModulePath);
    expect(resolveExistingNodeModule('onnxruntime-node', options)).toBe(managedModulePath);
    expect(resolveBundledPath('dist/web', options)).toBe(path.join(bundledRoot, 'dist', 'web'));
  });

  it('ignores active managed runtime roots outside userData runtime while keeping in-bounds roots loadable', () => {
    const bundledRoot = makeTempRoot();
    const userDataPath = makeTempRoot();
    const escapedAssetRoot = makeTempRoot();
    const runtimeBaseDir = mkdirp(path.join(userDataPath, 'runtime'));
    const managedAssetRoot = mkdirp(path.join(runtimeBaseDir, 'onnxruntime-vad', 'a'.repeat(64)));
    const escapedModulePath = mkdirp(path.join(escapedAssetRoot, 'node_modules', 'onnxruntime-node'));
    const managedModulePath = mkdirp(path.join(managedAssetRoot, 'node_modules', 'onnxruntime-node'));
    mkdirp(path.join(bundledRoot, 'dist', 'web'));
    const activeManifestPath = path.join(runtimeBaseDir, 'active.json');

    const options = {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: bundledRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
      userDataPath,
    };

    fs.writeFileSync(activeManifestPath, JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'escaped-onnxruntime-vad': {
          assetId: 'escaped-onnxruntime-vad',
          root: escapedAssetRoot,
          expandedSha256: 'c'.repeat(64),
          archiveSha256: 'd'.repeat(64),
          archiveFile: '/tmp/escaped-onnxruntime-vad.tar.gz',
          groups: ['node_modules/onnxruntime-node'],
          nodeModules: ['onnxruntime-node'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
      },
    }));

    expect(resolveExistingNodeModule('onnxruntime-node', options)).toBeNull();

    fs.writeFileSync(activeManifestPath, JSON.stringify({
      schemaVersion: 1,
      kind: 'agent_neo_runtime_assets_active',
      updatedAt: '2026-05-22T00:00:00.000Z',
      assets: {
        'escaped-onnxruntime-vad': {
          assetId: 'escaped-onnxruntime-vad',
          root: escapedAssetRoot,
          expandedSha256: 'c'.repeat(64),
          archiveSha256: 'd'.repeat(64),
          archiveFile: '/tmp/escaped-onnxruntime-vad.tar.gz',
          groups: ['node_modules/onnxruntime-node'],
          nodeModules: ['onnxruntime-node'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
        'onnxruntime-vad': {
          assetId: 'onnxruntime-vad',
          root: managedAssetRoot,
          expandedSha256: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          archiveFile: '/tmp/onnxruntime-vad.tar.gz',
          groups: ['node_modules/onnxruntime-node'],
          nodeModules: ['onnxruntime-node'],
          installedAt: '2026-05-22T00:00:00.000Z',
        },
      },
    }));

    expect(resolveExistingNodeModule('onnxruntime-node', options)).toBe(managedModulePath);
    expect(resolveExistingNodeModule('onnxruntime-node', {
      ...options,
      existsSync: (targetPath) => targetPath === escapedModulePath,
    })).toBeNull();
  });

  it('falls back to dist/native node_modules when top-level node_modules is absent', () => {
    const runtimeRoot = makeTempRoot();
    const nativeModulePath = mkdirp(path.join(runtimeRoot, 'dist', 'native', 'node_modules', 'better-sqlite3'));

    expect(resolveNodeModule('better-sqlite3', {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: runtimeRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBe(nativeModulePath);
  });

  it('resolves helper binaries from bundled scripts before dev scripts', () => {
    const runtimeRoot = makeTempRoot();
    const cwd = makeTempRoot();
    const bundledHelper = mkdirp(path.join(runtimeRoot, 'scripts'));
    const devHelper = mkdirp(path.join(cwd, 'scripts'));
    fs.writeFileSync(path.join(bundledHelper, 'vision-tagger'), '');
    fs.writeFileSync(path.join(devHelper, 'vision-tagger'), '');

    expect(resolveHelperBinary('vision-tagger', {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: runtimeRoot },
      cwd,
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBe(path.join(bundledHelper, 'vision-tagger'));
  });

  it('returns the most likely helper path even when it does not exist', () => {
    const runtimeRoot = makeTempRoot();

    expect(resolveHelperBinary('system-audio-capture', {
      env: { AGENT_NEO_BUNDLED_RUNTIME_ROOT: runtimeRoot },
      cwd: makeTempRoot(),
      dirname: path.join(makeTempRoot(), 'dist', 'web'),
    })).toBe(path.join(runtimeRoot, 'scripts', 'system-audio-capture'));
  });
});
