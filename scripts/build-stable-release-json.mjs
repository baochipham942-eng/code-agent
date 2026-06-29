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
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadReleaseNotes } from './lib/release-notes.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 安装包资产（dmg/exe）才需要 sha256；runtime manifest 的 json/sha sidecar 不算。
export function isInstallerAsset(name) {
  return typeof name === 'string' && /\.(dmg|exe)$/i.test(name);
}

// 真安装包至少 ~1MB；更小或 text/html、application/json 多半是 OSS 错误页/占位，
// 不能把它的 hash 当成安装包的 sha256（否则客户端会把错误页字节当成「校验通过」）。
const MIN_INSTALLER_BYTES = 1_000_000;
const SHA_FETCH_ATTEMPTS = 3;

// 从资产 URL 下载并算 sha256（哈希的正是用户将下载的字节，源头即 OSS 上传后的安装包）。
// 拒绝明显不是安装包的响应（错误页/占位），避免给坏内容盖上「有效 sha256」。
export async function computeAssetSha256(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new Error(`unexpected content-type "${contentType}" — not an installer`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_INSTALLER_BYTES) {
    throw new Error(`asset too small (${buf.length} bytes) — likely an error page, not an installer`);
  }
  return createHash('sha256').update(buf).digest('hex');
}

// 给每个安装包资产补 sha256。sha256 是附加加固：瞬时失败先重试，重试用尽仍失败就
// 省略该资产的 sha256（退回客户端「override 放行」行为），绝不抛错阻断发版。
// enabled=false 时整体跳过（不触网）。
export async function attachInstallerShas(assets, { enabled = false, fetchImpl = fetch, log = console } = {}) {
  if (!enabled) return assets;
  for (const asset of assets) {
    if (!asset?.name || !asset.browser_download_url || !isInstallerAsset(asset.name)) continue;
    let lastErr;
    for (let attempt = 1; attempt <= SHA_FETCH_ATTEMPTS; attempt += 1) {
      try {
        asset.sha256 = await computeAssetSha256(asset.browser_download_url, fetchImpl);
        log.log?.(`sha256 ${asset.name}: ${asset.sha256}`);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      log.warn?.(`[WARN] sha256 计算失败（${SHA_FETCH_ATTEMPTS} 次重试后），省略 ${asset.name}: ${lastErr?.message ?? lastErr}`);
    }
  }
  return assets;
}

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

async function main() {
  const version = arg('version');
  const dmgUrl = arg('dmg-url');
  const tag = arg('tag', version ? `v${version}` : undefined);
  const htmlUrl = arg('html-url', '');
  const output = arg('output', 'stable-release.json');
  const runtimeAssetsManifestUrl = arg('runtime-assets-manifest-url');
  const runtimeAssetsManifestShaUrl = arg('runtime-assets-manifest-sha-url');
  // x64（Intel）侧资产：可选。提供后单个 release.json 同时含 arm64 + x64，
  // Vercel /api/update 按 ?arch= 选对应 dmg / runtime manifest（见 updateMetadata.ts selectAsset）。
  const dmgUrlX64 = arg('dmg-url-x64');
  const runtimeAssetsManifestUrlX64 = arg('runtime-assets-manifest-url-x64');
  const runtimeAssetsManifestShaUrlX64 = arg('runtime-assets-manifest-sha-url-x64');
  // Windows（NSIS setup.exe）侧资产：可选。updateMetadata 按 platform=win32 选 .exe 资产。
  const exeUrl = arg('exe-url');
  // 给安装包资产补 sha256（从 OSS URL 下载回算）。仅 CI 加此 flag——本地/单测不触网。
  const computeAssetSha = process.argv.includes('--compute-asset-sha256');

  if (!version || !dmgUrl) {
    console.error('错误：--version 和 --dmg-url 必填。');
    process.exit(1);
  }

  if (Boolean(runtimeAssetsManifestUrl) !== Boolean(runtimeAssetsManifestShaUrl)) {
    console.error('错误：--runtime-assets-manifest-url 和 --runtime-assets-manifest-sha-url 必须同时提供。');
    process.exit(1);
  }

  if (Boolean(runtimeAssetsManifestUrlX64) !== Boolean(runtimeAssetsManifestShaUrlX64)) {
    console.error('错误：--runtime-assets-manifest-url-x64 和 --runtime-assets-manifest-sha-url-x64 必须同时提供。');
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

  if (dmgUrlX64) {
    assets.push({
      name: `Agent-Neo-${version}-x64.dmg`,
      browser_download_url: dmgUrlX64,
    });
  }

  if (exeUrl) {
    assets.push({
      name: assetNameFromUrl(exeUrl, `Agent-Neo-${version}-win-x64-setup.exe`),
      browser_download_url: exeUrl,
    });
  }

  if (runtimeAssetsManifestUrlX64 && runtimeAssetsManifestShaUrlX64) {
    assets.push(
      {
        name: assetNameFromUrl(runtimeAssetsManifestUrlX64, 'runtime-assets-manifest-darwin-x64.json'),
        browser_download_url: runtimeAssetsManifestUrlX64,
      },
      {
        name: assetNameFromUrl(runtimeAssetsManifestShaUrlX64, 'runtime-assets-manifest-darwin-x64.sha256'),
        browser_download_url: runtimeAssetsManifestShaUrlX64,
      },
    );
  }

  await attachInstallerShas(assets, { enabled: computeAssetSha });

  const release = {
    tag_name: tag,
    html_url: htmlUrl,
    published_at: new Date().toISOString(),
    body: await loadReleaseNotes(rootDir, version, arg('notes')),
    assets,
  };

  fs.writeFileSync(output, `${JSON.stringify(release, null, 2)}\n`);
  console.log(`Wrote ${output}: ${tag} -> ${dmgUrl}`);
}

// 仅作为 CLI 直接运行时执行 main；被测试 import 时只暴露纯函数，不触发 argv 解析/写文件。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
