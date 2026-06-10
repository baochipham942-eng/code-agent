import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installRuntimeAssetFromManifest,
  readActiveRuntimeAssets,
  validateRuntimeArchiveEntries,
  type RuntimeAssetsManifest,
} from '../../../src/main/runtime/runtimeAssetInstaller';

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
