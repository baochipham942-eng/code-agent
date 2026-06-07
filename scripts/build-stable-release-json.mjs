#!/usr/bin/env node
// ============================================================================
// 生成 stable/release.json（GitHub-release 形状），供 in-app updater 使用。
//
// 客户端 in-app 更新链：Vercel /api/update → updateMetadata.ts 读 OSS stable/release.json。
// 它只需 tag_name + 一个文件名含 .dmg 的 asset（name + browser_download_url）即可判版+给下载。
//
// CI 在「正式 tag 发版」后调用本脚本，把 dmg 指向 OSS（私有 GitHub 仓库匿名下不了，必须走 OSS）。
// 历来这步是手动补的（0.16.88/0.16.90/0.16.92），现纳入流水线。
//
// 用法：
//   node scripts/build-stable-release-json.mjs \
//     --version 0.16.92 --tag v0.16.92 \
//     --dmg-url https://<bucket>.oss-<region>.aliyuncs.com/v0.16.92/Agent-Neo-0.16.92-arm64.dmg \
//     --html-url https://github.com/<owner>/<repo>/releases/tag/v0.16.92 \
//     --output /tmp/stable-release.json
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseNotes } from './lib/release-notes.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function assetNameFromUrl(value, fallback) {
  try {
    const pathname = new URL(value).pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).at(-1) || fallback);
  } catch {
    return fallback;
  }
}

const version = arg('version');
const dmgUrl = arg('dmg-url');
const tag = arg('tag', version ? `v${version}` : undefined);
const htmlUrl = arg('html-url', '');
const output = arg('output', 'stable-release.json');
const runtimeAssetsManifestUrl = arg('runtime-assets-manifest-url');
const runtimeAssetsManifestShaUrl = arg('runtime-assets-manifest-sha-url');

if (!version || !dmgUrl) {
  console.error('错误：--version 和 --dmg-url 必填。');
  process.exit(1);
}

if (Boolean(runtimeAssetsManifestUrl) !== Boolean(runtimeAssetsManifestShaUrl)) {
  console.error('错误：--runtime-assets-manifest-url 和 --runtime-assets-manifest-sha-url 必须同时提供。');
  process.exit(1);
}

const assets = [
  {
    name: `Agent-Neo-${version}-arm64.dmg`,
    browser_download_url: dmgUrl,
  },
];

if (runtimeAssetsManifestUrl && runtimeAssetsManifestShaUrl) {
  assets.push(
    {
      name: assetNameFromUrl(runtimeAssetsManifestUrl, 'runtime-assets-manifest-darwin-arm64.json'),
      browser_download_url: runtimeAssetsManifestUrl,
    },
    {
      name: assetNameFromUrl(runtimeAssetsManifestShaUrl, 'runtime-assets-manifest-darwin-arm64.sha256'),
      browser_download_url: runtimeAssetsManifestShaUrl,
    },
  );
}

const release = {
  tag_name: tag,
  html_url: htmlUrl,
  published_at: new Date().toISOString(),
  body: await loadReleaseNotes(rootDir, version, arg('notes')),
  assets,
};

fs.writeFileSync(output, `${JSON.stringify(release, null, 2)}\n`);
console.log(`Wrote ${output}: ${tag} -> ${dmgUrl}`);
