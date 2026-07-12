#!/usr/bin/env node
// ============================================================================
// 前端热更：构建 + 签名 renderer bundle（独立于整包发版）
// ============================================================================
// 这才是「省发版」的真义：前端改动只跑这个（~1min），不走 cargo build/公证（~25min）。
//
// 流程：vite build → tar(dist/renderer) → sha256 → manifest → 控制面验签 envelope。
// 产物 manifest.json + bundle.tar.gz 由 CI 用 ossutil 传到
// oss://bucket/renderer-bundle/latest/ + 版本快照 renderer-bundle/v${VERSION}/。
//
// 兜底：缺签名 key 时（非 dry-run）fail closed，绝不产出未签名 manifest。

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlaneEnvelopeFromEnv } from '../vercel-api/lib/controlPlaneEnvelope.ts';
import { getShellCapabilityIds } from '../src/host/shellCapabilities.ts';
import { collectRendererShellCapabilities } from './renderer-capability-scanner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
export const SHELL_CAPABILITY_GATE_MIN_VERSION = '0.16.93';
export const RENDERER_ROLLBACK_MIN_VERSION = '0.16.93';
export const DEFAULT_RENDERER_BUNDLE_MANIFEST_TTL_SECONDS = 365 * 24 * 60 * 60;

/** 计算文件 sha256（hex），文件缺失则抛错（fail closed）。 */
function fileSha256(filePath) {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareArchiveEntryNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectRendererArchiveEntries(rendererDir, relativeDir = '') {
  const absoluteDir = path.join(rendererDir, relativeDir);
  const entries = [];
  for (const name of fs.readdirSync(absoluteDir).sort(compareArchiveEntryNames)) {
    const relativePath = relativeDir ? path.join(relativeDir, name) : name;
    const absolutePath = path.join(rendererDir, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) {
      entries.push(...collectRendererArchiveEntries(rendererDir, relativePath));
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      entries.push(relativePath);
    } else {
      throw new Error(`createDeterministicRendererArchive: unsupported entry type: ${absolutePath}`);
    }
  }
  return entries;
}

export function createDeterministicRendererArchive({ rendererDir, archivePath }) {
  if (!archivePath.endsWith('.tar.gz')) {
    throw new Error('createDeterministicRendererArchive: archivePath must end with .tar.gz');
  }
  const entries = collectRendererArchiveEntries(rendererDir);
  if (entries.length === 0) {
    throw new Error('createDeterministicRendererArchive: renderer directory is empty');
  }

  // Formal main + tag pushes can start two renderer workflows for the same SHA.
  // Normalize archive metadata so both publishers produce the same contentHash.
  const epoch = new Date(0);
  for (const relativePath of entries) {
    const absolutePath = path.join(rendererDir, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() && typeof fs.lutimesSync === 'function') {
      fs.lutimesSync(absolutePath, epoch, epoch);
    } else if (!stat.isSymbolicLink()) {
      fs.utimesSync(absolutePath, epoch, epoch);
    }
  }

  const tarPath = archivePath.slice(0, -3);
  fs.rmSync(tarPath, { force: true });
  fs.rmSync(archivePath, { force: true });
  const tarArgs = ['--format=ustar'];
  if (process.platform === 'linux') {
    tarArgs.push('--owner=0', '--group=0', '--numeric-owner');
  }
  tarArgs.push('-cf', tarPath, '-C', rendererDir, ...entries);
  execFileSync('tar', tarArgs, {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  // `tar -z` embeds the current time on bsdtar. gzip -n fixes the gzip header.
  execFileSync('gzip', ['-n', '-f', tarPath], { stdio: 'inherit' });
}

/**
 * 构建 renderer bundle manifest（RendererBundleManifest 形状）。
 * contentHash = bundle.tar.gz 的 sha256；minShellVersion 默认等于 bundle 版本
 * （即「该前端针对当前壳构建」，只有引入需要更新壳的新 IPC 时才手动调高）。
 */
function normalizeManifestStringList(fieldName, values) {
  if (!values || values.length === 0) {
    return [];
  }
  const trimmed = values.map((entry) => String(entry).trim());
  if (trimmed.some((entry) => entry.length === 0)) {
    throw new Error(`buildRendererBundleManifest: ${fieldName} must not contain empty values`);
  }
  return [...new Set(trimmed)];
}

function normalizeRequiredShellCapabilities(requiredShellCapabilities) {
  return normalizeManifestStringList('requiredShellCapabilities', requiredShellCapabilities);
}

function validateRequiredShellCapabilities(requiredShellCapabilities, supportedShellCapabilities) {
  const supported = new Set(supportedShellCapabilities);
  return requiredShellCapabilities.filter((id) => !supported.has(id));
}

function compareShellVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const parts2 = v2.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(parts1.length, parts2.length); index += 1) {
    const p1 = parts1[index] || 0;
    const p2 = parts2[index] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export function assertCapabilityGateSupported(minShellVersion, requiredShellCapabilities) {
  if (
    requiredShellCapabilities.length > 0 &&
    compareShellVersions(minShellVersion, SHELL_CAPABILITY_GATE_MIN_VERSION) < 0
  ) {
    throw new Error(
      `buildRendererBundleManifest: requiredShellCapabilities need minShellVersion >= ${SHELL_CAPABILITY_GATE_MIN_VERSION}`,
    );
  }
}

export function assertRendererRollbackSupported(minShellVersion) {
  if (compareShellVersions(minShellVersion, RENDERER_ROLLBACK_MIN_VERSION) < 0) {
    throw new Error(
      `buildRendererRollbackManifest: rollbackToBuiltin needs minShellVersion >= ${RENDERER_ROLLBACK_MIN_VERSION}`,
    );
  }
}

export function buildRendererBundleManifest({
  archivePath,
  version,
  minShellVersion,
  bundleUrl,
  requiredShellCapabilities,
  requiredRuntimeAssets,
  requiredResources,
}) {
  if (!version) throw new Error('buildRendererBundleManifest: version is required');
  if (!bundleUrl) throw new Error('buildRendererBundleManifest: bundleUrl is required');
  const contentHash = fileSha256(archivePath); // 文件缺失 → readFileSync 抛错
  const required = normalizeRequiredShellCapabilities(requiredShellCapabilities);
  const runtimeAssets = normalizeManifestStringList('requiredRuntimeAssets', requiredRuntimeAssets);
  const resources = normalizeManifestStringList('requiredResources', requiredResources);
  const manifestMinShellVersion = minShellVersion ?? version;
  assertCapabilityGateSupported(manifestMinShellVersion, required);
  return {
    version,
    contentHash,
    minShellVersion: manifestMinShellVersion,
    bundleUrl,
    ...(required.length > 0 ? { requiredShellCapabilities: required } : {}),
    ...(runtimeAssets.length > 0 ? { requiredRuntimeAssets: runtimeAssets } : {}),
    ...(resources.length > 0 ? { requiredResources: resources } : {}),
  };
}

export function buildRendererRollbackManifest({
  version,
  minShellVersion,
  rollbackReason,
  requiredShellCapabilities,
}) {
  if (!version) throw new Error('buildRendererRollbackManifest: version is required');
  const required = normalizeRequiredShellCapabilities(requiredShellCapabilities);
  const manifestMinShellVersion = minShellVersion ?? version;
  assertRendererRollbackSupported(manifestMinShellVersion);
  assertCapabilityGateSupported(manifestMinShellVersion, required);
  return {
    version,
    minShellVersion: manifestMinShellVersion,
    rollbackToBuiltin: true,
    ...(rollbackReason ? { rollbackReason } : {}),
    ...(required.length > 0 ? { requiredShellCapabilities: required } : {}),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function readArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
function readArgs(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}
function hasFlag(name) {
  return process.argv.includes(name);
}
function readArgFrom(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function parsePositiveInteger(value, source) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${source} must be a positive integer`);
  }
  return parsed;
}

export function resolveRendererBundleSigningOptions({
  argv = process.argv,
  env = process.env,
} = {}) {
  const explicitExpiresAt = readArgFrom(argv, '--manifest-expires-at')
    || env.RENDERER_BUNDLE_MANIFEST_EXPIRES_AT
    || env.CODE_AGENT_RENDERER_BUNDLE_MANIFEST_EXPIRES_AT;
  if (explicitExpiresAt) {
    const expiresAtMs = Date.parse(explicitExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new Error('--manifest-expires-at must be a valid date string');
    }
    return { expiresAt: new Date(expiresAtMs).toISOString() };
  }

  const ttlRaw = readArgFrom(argv, '--manifest-ttl-seconds')
    || env.RENDERER_BUNDLE_MANIFEST_TTL_SECONDS
    || env.CODE_AGENT_RENDERER_BUNDLE_MANIFEST_TTL_SECONDS;
  return {
    ttlSeconds: ttlRaw
      ? parsePositiveInteger(ttlRaw, '--manifest-ttl-seconds')
      : DEFAULT_RENDERER_BUNDLE_MANIFEST_TTL_SECONDS,
  };
}

function main() {
  const version = readArg('--version') || process.env.VERSION || readPackageVersion();
  const minShellVersion = readArg('--min-shell-version') || version;
  const rendererDir = path.resolve(readArg('--renderer-dir') || path.join(repoRoot, 'dist/renderer'));
  const rendererSourceDir = path.resolve(readArg('--renderer-source-dir') || path.join(repoRoot, 'src/renderer'));
  const outputDir = path.resolve(readArg('--output-dir') || path.join(repoRoot, 'dist/renderer-bundle'));
  // bundle.tar.gz 在 OSS 的最终落点（fetcher 据 manifest.bundleUrl 下载）
  const bundleBaseUrl = readArg('--bundle-base-url')
    || 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest';
  const bundleUrl = `${bundleBaseUrl.replace(/\/$/, '')}/bundle.tar.gz`;
  const requiredShellCapabilities = [
    ...(readArg('--required-shell-capabilities') || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...readArgs('--require-shell-capability'),
  ];
  const requiredRuntimeAssets = [
    ...(readArg('--required-runtime-assets') || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...readArgs('--require-runtime-asset'),
  ];
  const requiredResources = [
    ...(readArg('--required-resources') || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    ...readArgs('--require-resource'),
  ];
  const detectShellCapabilities = !hasFlag('--no-detect-shell-capabilities');
  const skipBuild = hasFlag('--skip-build');
  const dryRun = hasFlag('--dry-run');
  const rollbackToBuiltin = hasFlag('--rollback-to-builtin');
  const rollbackReason = readArg('--rollback-reason');
  const signingOptions = resolveRendererBundleSigningOptions();

  fs.mkdirSync(outputDir, { recursive: true });

  if (rollbackToBuiltin) {
    const required = normalizeRequiredShellCapabilities(requiredShellCapabilities);
    const unsupportedShellCapabilities = validateRequiredShellCapabilities(
      required,
      getShellCapabilityIds(),
    );
    if (unsupportedShellCapabilities.length > 0) {
      throw new Error(
        `buildRendererRollbackManifest: unsupported shell capabilities: ${unsupportedShellCapabilities.join(', ')}`,
      );
    }
    const manifest = buildRendererRollbackManifest({
      version,
      minShellVersion,
      rollbackReason,
      requiredShellCapabilities: required,
    });
    const hasKey = Boolean(
      (process.env.CONTROL_PLANE_PRIVATE_KEY || process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY)
      && (process.env.CONTROL_PLANE_KEY_ID || process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID),
    );
    if (!hasKey && !dryRun) {
      throw new Error('control plane signing key not configured — refusing to emit unsigned renderer rollback manifest');
    }
    const envelope = (!hasKey && dryRun)
      ? manifest
      : createControlPlaneEnvelopeFromEnv('renderer_bundle', manifest, process.env, signingOptions);
    const manifestPath = path.join(outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
    console.log(`[build-renderer-bundle] rollback-to-builtin version=${version} minShell=${manifest.minShellVersion}`);
    console.log(`[build-renderer-bundle] manifest: ${path.relative(repoRoot, manifestPath)} (signed=${hasKey})`);
    return;
  }

  // 1. build renderer（除非显式跳过，CI 里通常已 build 好）
  if (!skipBuild) {
    console.log('[build-renderer-bundle] vite build renderer ...');
    execFileSync('npm', ['run', 'build:renderer'], { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(rendererDir, 'index.html'))) {
    throw new Error(`renderer build output missing index.html: ${rendererDir}`);
  }

  // 2. deterministic tar(dist/renderer 内容到根) → output/bundle.tar.gz
  const archivePath = path.join(outputDir, 'bundle.tar.gz');
  createDeterministicRendererArchive({ rendererDir, archivePath });

  // 3. manifest + sha256 + shell capability contract
  const detectedShellCapabilities = detectShellCapabilities
    ? collectRendererShellCapabilities({
      rendererDir: rendererSourceDir,
      domainsPath: path.join(repoRoot, 'src/shared/ipc/domains.ts'),
      repoRoot,
    }).map((capability) => capability.id)
    : [];
  const shellCapabilities = normalizeRequiredShellCapabilities([
    ...detectedShellCapabilities,
    ...requiredShellCapabilities,
  ]);
  const runtimeAssets = normalizeManifestStringList('requiredRuntimeAssets', requiredRuntimeAssets);
  const resources = normalizeManifestStringList('requiredResources', requiredResources);
  const unsupportedShellCapabilities = validateRequiredShellCapabilities(
    shellCapabilities,
    getShellCapabilityIds(),
  );
  if (unsupportedShellCapabilities.length > 0) {
    throw new Error(
      `buildRendererBundleManifest: unsupported shell capabilities: ${unsupportedShellCapabilities.join(', ')}`,
    );
  }
  console.log(`[build-renderer-bundle] shell capabilities: ${shellCapabilities.length} required (${detectedShellCapabilities.length} detected)`);
  console.log(`[build-renderer-bundle] runtime assets: ${runtimeAssets.length} required`);
  console.log(`[build-renderer-bundle] resources: ${resources.length} required`);
  const manifest = buildRendererBundleManifest({
    archivePath,
    version,
    minShellVersion,
    bundleUrl,
    requiredShellCapabilities: shellCapabilities,
    requiredRuntimeAssets: runtimeAssets,
    requiredResources: resources,
  });

  // 4. 控制面签名 envelope（dryRun 且无 key 时输出未签名 manifest 供本地预览）
  const hasKey = Boolean(
    (process.env.CONTROL_PLANE_PRIVATE_KEY || process.env.CODE_AGENT_CONTROL_PLANE_PRIVATE_KEY)
    && (process.env.CONTROL_PLANE_KEY_ID || process.env.CODE_AGENT_CONTROL_PLANE_KEY_ID),
  );
  if (!hasKey && !dryRun) {
    throw new Error('control plane signing key not configured — refusing to emit unsigned renderer manifest');
  }
  const envelope = (!hasKey && dryRun)
    ? manifest
    : createControlPlaneEnvelopeFromEnv('renderer_bundle', manifest, process.env, signingOptions);

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);

  console.log(`[build-renderer-bundle] version=${version} minShell=${minShellVersion}`);
  console.log(`[build-renderer-bundle] contentHash=${manifest.contentHash}`);
  console.log(`[build-renderer-bundle] archive: ${path.relative(repoRoot, archivePath)}`);
  console.log(`[build-renderer-bundle] manifest: ${path.relative(repoRoot, manifestPath)} (signed=${hasKey})`);
}

// 仅作为脚本直接运行时执行 main，被 import（测试）时不执行
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
