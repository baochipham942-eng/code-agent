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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** 计算文件 sha256（hex），文件缺失则抛错（fail closed）。 */
function fileSha256(filePath) {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * 构建 renderer bundle manifest（RendererBundleManifest 形状）。
 * contentHash = bundle.tar.gz 的 sha256；minShellVersion 默认等于 bundle 版本
 * （即「该前端针对当前壳构建」，只有引入需要更新壳的新 IPC 时才手动调高）。
 */
export function buildRendererBundleManifest({ archivePath, version, minShellVersion, bundleUrl }) {
  if (!version) throw new Error('buildRendererBundleManifest: version is required');
  if (!bundleUrl) throw new Error('buildRendererBundleManifest: bundleUrl is required');
  const contentHash = fileSha256(archivePath); // 文件缺失 → readFileSync 抛错
  return {
    version,
    contentHash,
    minShellVersion: minShellVersion ?? version,
    bundleUrl,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function readArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(name);
}
function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function main() {
  const version = readArg('--version') || process.env.VERSION || readPackageVersion();
  const minShellVersion = readArg('--min-shell-version') || version;
  const rendererDir = path.resolve(readArg('--renderer-dir') || path.join(repoRoot, 'dist/renderer'));
  const outputDir = path.resolve(readArg('--output-dir') || path.join(repoRoot, 'dist/renderer-bundle'));
  // bundle.tar.gz 在 OSS 的最终落点（fetcher 据 manifest.bundleUrl 下载）
  const bundleBaseUrl = readArg('--bundle-base-url')
    || 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest';
  const bundleUrl = `${bundleBaseUrl.replace(/\/$/, '')}/bundle.tar.gz`;
  const skipBuild = hasFlag('--skip-build');
  const dryRun = hasFlag('--dry-run');

  // 1. build renderer（除非显式跳过，CI 里通常已 build 好）
  if (!skipBuild) {
    console.log('[build-renderer-bundle] vite build renderer ...');
    execFileSync('npm', ['run', 'build:renderer'], { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(rendererDir, 'index.html'))) {
    throw new Error(`renderer build output missing index.html: ${rendererDir}`);
  }

  // 2. tar(dist/renderer 内容到根) → output/bundle.tar.gz
  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', rendererDir, '.'], { stdio: 'inherit' });

  // 3. manifest + sha256
  const manifest = buildRendererBundleManifest({ archivePath, version, minShellVersion, bundleUrl });

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
    : createControlPlaneEnvelopeFromEnv('renderer_bundle', manifest);

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
