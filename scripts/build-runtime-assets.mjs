#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createControlPlaneEnvelopeFromEnv } from '../vercel-api/lib/controlPlaneEnvelope.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultRuntimeRoot = repoRoot;
const defaultOutputDir = path.join(repoRoot, 'src-tauri', 'target', 'release', 'runtime-assets');

// 按目标架构生成 asset 组：sharp / onnxruntime 的 native 路径随 arch（darwin-arm64 / darwin-x64）。
function buildAssetGroups(arch) {
  return {
    'onnxruntime-vad': {
      id: 'onnxruntime-vad',
      description: 'ONNX Runtime plus Silero VAD model assets for desktop audio capture.',
      entries: [
        'node_modules/onnxruntime-node/package.json',
        'node_modules/onnxruntime-node/dist',
        `node_modules/onnxruntime-node/bin/napi-v6/darwin/${arch}`,
        'node_modules/onnxruntime-common/package.json',
        'node_modules/onnxruntime-common/dist/cjs',
        'node_modules/avr-vad/dist/silero_vad_v5.onnx',
      ],
      nodeModules: [
        'onnxruntime-node',
        'avr-vad',
      ],
    },
    'playwright-browser-runtime': {
      id: 'playwright-browser-runtime',
      description: 'Playwright client runtime for browser automation and visual smoke checks.',
      entries: [
        'node_modules/playwright',
        'node_modules/playwright-core',
      ],
      nodeModules: [
        'playwright',
        'playwright-core',
      ],
    },
    'sharp-image-runtime': {
      id: 'sharp-image-runtime',
      description: 'Sharp native image processing runtime for screenshots and image tools.',
      entries: [
        'node_modules/sharp',
        'node_modules/@img/colour',
        `node_modules/@img/sharp-darwin-${arch}`,
        `node_modules/@img/sharp-libvips-darwin-${arch}`,
        'node_modules/detect-libc',
      ],
      nodeModules: [
        'sharp',
        '@img/colour',
        `@img/sharp-darwin-${arch}`,
        `@img/sharp-libvips-darwin-${arch}`,
        'detect-libc',
      ],
    },
  };
}

// x64（Intel）不适配的 asset：onnxruntime-vad 的 npm 包无 darwin/x64 二进制，
// VAD 在 x64 走「缺 runtime 优雅降级」（见 docs/architecture/intel-x64-support.md）。
const ARM64_ONLY_ASSET_IDS = new Set(['onnxruntime-vad']);

const DEFAULT_RUNTIME_ASSET_IDS = [
  'onnxruntime-vad',
  'playwright-browser-runtime',
];

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readRepeatedArg(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(2)} TiB`;
}

function joinUrl(baseUrl, fileName) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(fileName, normalizedBase).toString();
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function ensureInside(baseDir, targetPath, label) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${resolvedBase}: ${targetPath}`);
  }
  return resolvedTarget;
}

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
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

function treeHash(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(sha256File(file.path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function detectPlatform() {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch;
  return `${platform}-${arch}`;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return packageJson.version;
}

function copyAssetEntries(asset, runtimeRoot, stagingDir) {
  for (const entry of asset.entries) {
    const source = ensureInside(runtimeRoot, path.join(runtimeRoot, entry), 'asset entry');
    if (!fs.existsSync(source)) {
      throw new Error(`Missing runtime asset entry for ${asset.id}: ${entry}`);
    }

    const destination = ensureInside(stagingDir, path.join(stagingDir, entry), 'asset destination');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}

function createArchive(stagingDir, archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  execFileSync('tar', ['-czf', archivePath, '-C', stagingDir, '.'], { stdio: 'inherit' });
}

function runSecurityScan(stagingDir) {
  execFileSync('node', [path.join(scriptDir, 'release-security-scan.mjs'), stagingDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function pruneRuntimeOnlyArtifacts(stagingDir) {
  const stack = [stagingDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(stagingDir, fullPath));
      if (entry.isSymbolicLink()) {
        fs.rmSync(fullPath, { force: true });
        continue;
      }
      if (entry.isDirectory()) {
        if (relativePath === 'node_modules/.bin' || relativePath.endsWith('/node_modules/.bin')) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          continue;
        }
        stack.push(fullPath);
      }
    }
  }

  for (const file of walkFiles(stagingDir)) {
    if (
      file.relativePath.endsWith('.map')
      || file.relativePath.endsWith('.d.ts')
    ) {
      fs.rmSync(file.path, { force: true });
    }
  }
}

function buildAsset(asset, options) {
  const archiveBaseName = `${asset.id}-${options.platform}-${options.appVersion}.tar.gz`;
  const assetOutputDir = options.flatOutput ? options.outputDir : path.join(options.outputDir, asset.id);
  const stagingDir = path.join(options.outputDir, '.tmp', `${asset.id}-${process.pid}`);
  const archivePath = path.join(assetOutputDir, archiveBaseName);

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    copyAssetEntries(asset, options.runtimeRoot, stagingDir);
    pruneRuntimeOnlyArtifacts(stagingDir);
    if (!options.skipSecurityScan) {
      runSecurityScan(stagingDir);
    }
    const files = walkFiles(stagingDir);
    const expandedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const expandedSha256 = treeHash(files);

    if (!options.dryRun) {
      fs.rmSync(archivePath, { force: true });
      createArchive(stagingDir, archivePath);
    }

    const archiveBytes = options.dryRun ? 0 : fs.statSync(archivePath).size;
    const archiveSha256 = options.dryRun ? null : sha256File(archivePath);

    return {
      id: asset.id,
      description: asset.description,
      platform: options.platform,
      groups: asset.entries,
      nodeModules: asset.nodeModules,
      archiveFile: options.archiveBaseUrl
        ? joinUrl(options.archiveBaseUrl, archiveBaseName)
        : path.relative(options.outputDir, archivePath),
      archiveBytes,
      archiveSize: formatBytes(archiveBytes),
      archiveSha256,
      expandedBytes,
      expandedSize: formatBytes(expandedBytes),
      expandedSha256,
      fileCount: files.length,
      compatibility: {
        minAppVersion: options.appVersion,
        maxAppVersion: null,
      },
      install: {
        root: `runtime/${asset.id}/${expandedSha256}`,
      },
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function writeManifest(manifest, outputDir, manifestName) {
  const manifestPath = path.join(outputDir, manifestName);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function hasControlPlaneSigningEnv() {
  const privateKey = process.env.CONTROL_PLANE_PRIVATE_KEY || process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY;
  const keyId = process.env.CONTROL_PLANE_KEY_ID || process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID;
  return Boolean(privateKey && privateKey.trim() && keyId && keyId.trim());
}

const DEFAULT_RUNTIME_ASSETS_MANIFEST_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

function getRuntimeAssetsManifestTtlSeconds() {
  const raw = process.env.RUNTIME_ASSETS_MANIFEST_TTL_SECONDS;
  if (!raw) return DEFAULT_RUNTIME_ASSETS_MANIFEST_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('RUNTIME_ASSETS_MANIFEST_TTL_SECONDS must be a positive number');
  }
  return parsed;
}

export function createRuntimeAssetsManifestEnvelope(manifest, { dryRun: isDryRun = false } = {}) {
  if (isDryRun && !hasControlPlaneSigningEnv()) {
    return manifest;
  }
  // Runtime asset manifests are immutable, versioned release artifacts. The
  // generic control-plane TTL defaults to one hour for live configuration and
  // must not make a shipped installer stop working after release day.
  return createControlPlaneEnvelopeFromEnv('runtime_assets_manifest', manifest, process.env, {
    ttlSeconds: getRuntimeAssetsManifestTtlSeconds(),
  });
}

const runtimeRoot = path.resolve(readArg('--root') || process.env.TAURI_RUNTIME_ROOT || defaultRuntimeRoot);
const outputDir = path.resolve(readArg('--output-dir') || process.env.RUNTIME_ASSET_OUTPUT_DIR || defaultOutputDir);
const appVersion = readArg('--app-version') || process.env.VERSION || readPackageVersion();
const platform = readArg('--platform') || process.env.RUNTIME_ASSET_PLATFORM || detectPlatform();
const manifestName = readArg('--manifest-name') || process.env.RUNTIME_ASSET_MANIFEST_NAME || 'manifest.json';
const archiveBaseUrl = readArg('--archive-base-url') || process.env.RUNTIME_ASSET_ARCHIVE_BASE_URL || '';
const requestedAssetIds = readRepeatedArg('--asset');
const dryRun = hasFlag('--dry-run');
const skipSecurityScan = hasFlag('--skip-security-scan');
const flatOutput = hasFlag('--flat-output');

// 目标架构从 platform（darwin-arm64 / darwin-x64）推导，决定 native asset 路径与 x64 跳过。
const targetArch = /(?:-x64|-x86_64)$/.test(platform) ? 'x64' : 'arm64';
const ASSET_GROUPS = buildAssetGroups(targetArch);

const selectedAssetIds = requestedAssetIds.length > 0
  ? requestedAssetIds
  : DEFAULT_RUNTIME_ASSET_IDS;

// x64 跳过 arm64-only asset（onnxruntime-vad），并显式 log 出来（不静默截断）。
const assetIds = selectedAssetIds.filter((assetId) => {
  if (targetArch === 'x64' && ARM64_ONLY_ASSET_IDS.has(assetId)) {
    console.log(`[build-runtime-assets] skip ${assetId} on x64 (arm64-only; VAD degrades to missing-runtime)`);
    return false;
  }
  return true;
});

for (const assetId of assetIds) {
  if (!ASSET_GROUPS[assetId]) {
    throw new Error(`Unknown runtime asset: ${assetId}. Known assets: ${Object.keys(ASSET_GROUPS).join(', ')}`);
  }
}

if (!fs.existsSync(runtimeRoot)) {
  throw new Error(`Runtime root does not exist: ${runtimeRoot}`);
}

fs.mkdirSync(outputDir, { recursive: true });

const assets = assetIds.map((assetId) => buildAsset(ASSET_GROUPS[assetId], {
  runtimeRoot,
  outputDir,
  appVersion,
  platform,
  dryRun,
  skipSecurityScan,
  flatOutput,
  archiveBaseUrl,
}));

const manifest = {
  schemaVersion: 1,
  kind: 'agent_neo_runtime_assets',
  generatedAt: new Date().toISOString(),
  appVersion,
  platform,
  sourceRoot: runtimeRoot,
  assets,
};

const signedManifest = createRuntimeAssetsManifestEnvelope(manifest, { dryRun });
const manifestPath = writeManifest(signedManifest, outputDir, manifestName);

console.log(`[build-runtime-assets] wrote manifest: ${path.relative(repoRoot, manifestPath)}`);
for (const asset of assets) {
  console.log(
    `[build-runtime-assets] ${asset.id}: expanded ${asset.expandedSize}, archive ${asset.archiveSize}, files ${asset.fileCount}`,
  );
}
