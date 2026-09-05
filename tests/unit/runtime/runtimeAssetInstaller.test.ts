import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installRuntimeAssetFromManifest,
  readActiveRuntimeAssets,
  validateRuntimeArchiveEntries,
  type RuntimeAssetsManifest,
} from '../../../src/host/runtime/runtimeAssetInstaller';

vi.unmock('better-sqlite3');

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-runtime-installer-'));
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

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
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

function createArchive(stagingDir: string, archivePath: string): void {
  mkdirp(path.dirname(archivePath));
  execFileSync('tar', ['-czf', archivePath, '-C', stagingDir, '.']);
}

function createRuntimeAssetPackage(root: string, content: string): {
  archivePath: string;
  expandedSha256: string;
  archiveSha256: string;
} {
  const stagingDir = path.join(root, 'staging');
  writeFile(path.join(stagingDir, 'node_modules', 'onnxruntime-node', 'index.js'), content);
  writeFile(path.join(stagingDir, 'node_modules', 'avr-vad', 'dist', 'silero_vad_v5.onnx'), `model:${content}`);

  const archivePath = path.join(root, 'packages', 'onnxruntime-vad.tar.gz');
  createArchive(stagingDir, archivePath);

  return {
    archivePath,
    expandedSha256: treeHash(stagingDir),
    archiveSha256: sha256File(archivePath),
  };
}

function writeManifest(
  root: string,
  asset: {
    archivePath: string;
    archiveSha256: string;
    expandedSha256: string;
  },
  overrides: Partial<RuntimeAssetsManifest['assets'][number]> = {},
): string {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest: RuntimeAssetsManifest = {
    schemaVersion: 1,
    kind: 'agent_neo_runtime_assets',
    generatedAt: '2026-05-22T00:00:00.000Z',
    appVersion: '0.16.79',
    platform: 'darwin-arm64',
    assets: [{
      id: 'onnxruntime-vad',
      platform: 'darwin-arm64',
      groups: ['node_modules/onnxruntime-node', 'node_modules/avr-vad'],
      nodeModules: ['onnxruntime-node', 'avr-vad'],
      archiveFile: path.relative(root, asset.archivePath),
      archiveSha256: asset.archiveSha256,
      expandedSha256: asset.expandedSha256,
      compatibility: {
        minAppVersion: '0.16.78',
        maxAppVersion: null,
      },
      install: {
        root: `runtime/onnxruntime-vad/${asset.expandedSha256}`,
      },
      ...overrides,
    }],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runtimeAssetInstaller', () => {
  it.each(['equal', 'reversed'] as const)('retains installation order with %s directory mtimes and a backwards clock', async (mtimeOrder) => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const assets = ['v1', 'v2', 'v3'].map((content) => createRuntimeAssetPackage(path.join(root, content), content));
    const rename = fsPromises.rename.bind(fsPromises);
    const promotionMtimes: number[] = [];
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      const index = assets.findIndex((asset) => String(to) === path.join(runtimeBaseDir, 'onnxruntime-vad', asset.expandedSha256));
      if (index < 0) return;
      const time = new Date(mtimeOrder === 'equal' ? 100000 : 300000 - index * 100000);
      fs.utimesSync(to, time, time);
      promotionMtimes.push(fs.statSync(to).mtimeMs);
    });
    try {
      for (const [index, asset] of assets.entries()) {
        await installRuntimeAssetFromManifest({
          manifestPath: writeManifest(path.dirname(path.dirname(asset.archivePath)), asset),
          assetId: 'onnxruntime-vad',
          runtimeBaseDir,
          now: () => new Date(300000 - index * 100000),
        });
      }
    } finally {
      renameSpy.mockRestore();
    }
    expect(promotionMtimes).toEqual(mtimeOrder === 'equal' ? [100000, 100000, 100000] : [300000, 200000, 100000]);
    expect(fs.readdirSync(path.join(runtimeBaseDir, 'onnxruntime-vad')).sort()).toEqual([
      assets[1]!.expandedSha256, assets[2]!.expandedSha256,
    ].sort());
    const active = await readActiveRuntimeAssets(runtimeBaseDir);
    expect(active?.assets['onnxruntime-vad'].installationOrder?.lastSequence).toBe(3);
  });

  it('preserves legacy directories without order records even with keepPrevious zero', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const legacy = createRuntimeAssetPackage(path.join(root, 'legacy'), 'legacy');
    const legacyRoot = mkdirp(path.join(runtimeBaseDir, 'onnxruntime-vad', legacy.expandedSha256));
    execFileSync('tar', ['-xzf', legacy.archivePath, '-C', legacyRoot]);
    for (const content of ['v1', 'v2']) {
      const asset = createRuntimeAssetPackage(path.join(root, content), content);
      await installRuntimeAssetFromManifest({
        manifestPath: writeManifest(path.join(root, content), asset),
        assetId: 'onnxruntime-vad', runtimeBaseDir, keepPrevious: 0,
      });
    }
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(fs.readdirSync(path.join(runtimeBaseDir, 'onnxruntime-vad'))).toHaveLength(2);
  });

  it('records reactivation of an existing version as the newest installation', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const assets = ['v1', 'v2', 'v3'].map((content) => createRuntimeAssetPackage(path.join(root, content), content));
    for (const index of [0, 1, 0, 2]) {
      const asset = assets[index]!;
      await installRuntimeAssetFromManifest({
        manifestPath: writeManifest(path.dirname(path.dirname(asset.archivePath)), asset),
        assetId: 'onnxruntime-vad', runtimeBaseDir,
      });
    }
    expect(fs.readdirSync(path.join(runtimeBaseDir, 'onnxruntime-vad')).sort()).toEqual([
      assets[0]!.expandedSha256, assets[2]!.expandedSha256,
    ].sort());
  });

  it('fails closed while another connection holds the install lock without releasing its reservation', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    mkdirp(runtimeBaseDir);
    const lock = new Database(path.join(runtimeBaseDir, '.install-lock.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    const asset = createRuntimeAssetPackage(root, 'v1');
    try {
      await expect(installRuntimeAssetFromManifest({
        manifestPath: writeManifest(root, asset), assetId: 'onnxruntime-vad', runtimeBaseDir,
      })).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
      expect(lock.inTransaction).toBe(true);
      expect(await readActiveRuntimeAssets(runtimeBaseDir)).toBeNull();
    } finally {
      lock.close();
    }
  });

  it('can install after a lock holder is killed without deleting the lock database', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = mkdirp(path.join(root, 'runtime'));
    const lockPath = path.join(runtimeBaseDir, '.install-lock.sqlite');
    const child = spawnSync(process.execPath, ['-e', `
      const Database = require(process.argv[1]);
      const lock = new Database(process.argv[2]);
      lock.exec('BEGIN IMMEDIATE');
      process.kill(process.pid, 'SIGKILL');
    `, createRequire(import.meta.url).resolve('better-sqlite3'), lockPath]);
    expect(child.signal).toBe('SIGKILL');
    expect(fs.existsSync(lockPath)).toBe(true);
    const asset = createRuntimeAssetPackage(root, 'v1');
    const result = await installRuntimeAssetFromManifest({
      manifestPath: writeManifest(root, asset), assetId: 'onnxruntime-vad', runtimeBaseDir,
    });
    expect(fs.existsSync(result.root)).toBe(true);
    expect((await readActiveRuntimeAssets(runtimeBaseDir))?.assets['onnxruntime-vad'].installationOrder?.lastSequence).toBe(1);
  });

  it('installs a verified runtime asset and writes active state atomically', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const asset = createRuntimeAssetPackage(root, 'v1');
    const manifestPath = writeManifest(root, asset);

    const result = await installRuntimeAssetFromManifest({
      manifestPath,
      assetId: 'onnxruntime-vad',
      runtimeBaseDir,
      now: () => new Date('2026-05-22T01:00:00.000Z'),
    });

    expect(result.root).toBe(path.join(runtimeBaseDir, 'onnxruntime-vad', asset.expandedSha256));
    expect(fs.existsSync(path.join(result.root, 'node_modules', 'onnxruntime-node', 'index.js'))).toBe(true);
    const active = await readActiveRuntimeAssets(runtimeBaseDir);
    expect(active?.assets['onnxruntime-vad']).toMatchObject({
      assetId: 'onnxruntime-vad',
      root: result.root,
      expandedSha256: asset.expandedSha256,
      archiveSha256: asset.archiveSha256,
      minShellVersion: '0.16.78',
      nodeModules: ['onnxruntime-node', 'avr-vad'],
      installedAt: '2026-05-22T01:00:00.000Z',
    });
  });

  it('fails closed when the archive sha256 does not match', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const asset = createRuntimeAssetPackage(root, 'v1');
    const manifestPath = writeManifest(root, asset, {
      archiveSha256: '0'.repeat(64),
    });

    await expect(installRuntimeAssetFromManifest({
      manifestPath,
      assetId: 'onnxruntime-vad',
      runtimeBaseDir,
    })).rejects.toThrow(/archive sha256 mismatch/);
    expect(fs.existsSync(path.join(runtimeBaseDir, 'active.json'))).toBe(false);
  });

  it('fails closed when the expanded tree hash does not match', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const asset = createRuntimeAssetPackage(root, 'v1');
    const manifestPath = writeManifest(root, asset, {
      expandedSha256: '1'.repeat(64),
      install: {
        root: `runtime/onnxruntime-vad/${'1'.repeat(64)}`,
      },
    });

    await expect(installRuntimeAssetFromManifest({
      manifestPath,
      assetId: 'onnxruntime-vad',
      runtimeBaseDir,
    })).rejects.toThrow(/expanded sha256 mismatch/);
    expect(fs.existsSync(path.join(runtimeBaseDir, 'active.json'))).toBe(false);
  });

  it('rejects path traversal entries before extraction', () => {
    expect(() => validateRuntimeArchiveEntries(['./node_modules/pkg/index.js'])).not.toThrow();
    expect(() => validateRuntimeArchiveEntries(['../evil'])).toThrow(/traversal path/);
    expect(() => validateRuntimeArchiveEntries(['/tmp/evil'])).toThrow(/absolute path/);
  });

  it('rejects windows-style traversal and absolute entries before extraction', () => {
    // 反斜杠在 Windows 解压时是路径分隔符，按 '/' 分段的检查拦不住
    expect(() => validateRuntimeArchiveEntries(['..\\evil'])).toThrow(/invalid path/);
    expect(() => validateRuntimeArchiveEntries(['node_modules\\..\\..\\evil'])).toThrow(/invalid path/);
    expect(() => validateRuntimeArchiveEntries(['C:/Windows/evil'])).toThrow(/invalid path/);
    expect(() => validateRuntimeArchiveEntries(['c:\\evil'])).toThrow(/invalid path/);
    expect(() => validateRuntimeArchiveEntries(['\\\\server\\share\\evil'])).toThrow(/invalid path/);
  });

  it('rejects symlink entries before promotion', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const stagingDir = path.join(root, 'staging');
    mkdirp(path.join(stagingDir, 'node_modules', 'onnxruntime-node'));
    fs.symlinkSync('/tmp', path.join(stagingDir, 'node_modules', 'onnxruntime-node', 'escape'));

    const archivePath = path.join(root, 'packages', 'onnxruntime-vad.tar.gz');
    createArchive(stagingDir, archivePath);
    const manifestPath = writeManifest(root, {
      archivePath,
      archiveSha256: sha256File(archivePath),
      expandedSha256: '2'.repeat(64),
    }, {
      install: {
        root: `runtime/onnxruntime-vad/${'2'.repeat(64)}`,
      },
    });

    await expect(installRuntimeAssetFromManifest({
      manifestPath,
      assetId: 'onnxruntime-vad',
      runtimeBaseDir,
    })).rejects.toThrow(/unsupported link entry|symlink/);
    expect(fs.existsSync(path.join(runtimeBaseDir, 'active.json'))).toBe(false);
  });

  it('keeps the active version and one previous version', async () => {
    const root = makeTempRoot();
    const runtimeBaseDir = path.join(root, 'runtime');
    const assets = ['v1', 'v2', 'v3'].map((content) => createRuntimeAssetPackage(path.join(root, content), content));

    for (const asset of assets) {
      const manifestPath = writeManifest(path.dirname(path.dirname(asset.archivePath)), asset);
      await installRuntimeAssetFromManifest({
        manifestPath,
        assetId: 'onnxruntime-vad',
        runtimeBaseDir,
        keepPrevious: 1,
      });
    }

    const installed = fs.readdirSync(path.join(runtimeBaseDir, 'onnxruntime-vad')).sort();
    expect(installed).toHaveLength(2);
    expect(installed).toContain(assets[1]!.expandedSha256);
    expect(installed).toContain(assets[2]!.expandedSha256);
  });
});
