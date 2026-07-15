#!/usr/bin/env node
// ============================================================================
// 从 src-tauri/tauri.conf.json 派生指定平台的 bundle 覆盖配置。
// ============================================================================
// 背景：base conf 是 macOS 形态（resources 含 Swift sidecar / CUA .app /
//   darwin native 路径，targets=["app"]）。Windows 构建需要：
//   - 剔除 macOS 专属资源（缺文件 tauri build 直接失败，x64 先例 v0.16.89）
//   - native 路径换 win32（node-pty prebuilds / sharp，libvips 在 win32 静态
//     打进 sharp 包无独立条目）
//   - rtk/uv → .exe；targets → nsis（installMode=currentUser，否则每次自动
//     更新弹 UAC，windows-support.md §3.3 决策）
//
// 用法：
//   node scripts/tauri-platform-config.mjs win32-x64 [--out <path>]
//   cargo tauri build --config <path>
//
// 说明：
//   - Tauri --config 走 JSON merge patch；bundle.resources 是 object 时会深合并，
//     所以 source 改名/删减必须为旧 key 写 null deletion marker。
//     覆盖仍从 base 派生，避免两份配置漂移（同 tauri-arch-config.mjs 先例）。
//   - darwin 双架构走 scripts/tauri-arch-config.mjs（不动现有 CI）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'win32-x64') {
  console.error('用法: tauri-platform-config.mjs <win32-x64> [--out <path>]（darwin 用 tauri-arch-config.mjs）');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const resources = conf.bundle?.resources ?? [];

// macOS 专属资源：Windows bundle 必须剔除（按"平台不支持→优雅降级"决策，
// 对应能力的代码层降级见 windows-support.md §1.5）
const MACOS_ONLY_PREFIXES = [
  '../scripts/system-audio-capture',
  '../scripts/vision-ocr',
  '../scripts/vision-tagger',
  '../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app',
  // PII 安装链已 Node 化（setup-gliner-pii.mjs，2026-06-11），win32 照常带上
  '../node_modules/@img/sharp-libvips-darwin-arm64', // win32 libvips 静态打进 sharp 包
  // poppler 只在 macOS 打包：PPTX→PDF 的 LibreOffice 前置只有 mac 有，非 mac 平台
  // fetch-poppler.sh 直接跳过不生成该目录，运行时走既有降级链（windows-support.md §1.5）。
  // #380 把它加进 base conf 时漏了这里，Windows 构建自那天起一直炸在
  // "resource path ..\scripts\poppler doesn't exist"，直到 v0.27.2 真发版才暴露。
  '../scripts/poppler',
];

function shouldKeepResource(source) {
  return !MACOS_ONLY_PREFIXES.some((prefix) => source.startsWith(prefix));
}

function mapPath(entry) {
  return entry
    .replaceAll('node-pty/prebuilds/darwin-arm64', 'node-pty/prebuilds/win32-x64')
    .replaceAll('@img/sharp-darwin-arm64', '@img/sharp-win32-x64')
    // win32 sharp 包的 lib/ 同时含 .node 与 libvips DLL，必须整目录打包
    .replace('@img/sharp-win32-x64/lib/**/*.node', '@img/sharp-win32-x64/lib/**/*')
    .replace(/^\.\.\/scripts\/rtk$/, '../scripts/rtk.exe')
    .replace(/^\.\.\/scripts\/uv$/, '../scripts/uv.exe')
    .replace(/^scripts\/rtk$/, 'scripts/rtk.exe')
    .replace(/^scripts\/uv$/, 'scripts/uv.exe');
}

function mapResources(value) {
  if (Array.isArray(value)) {
    return value.filter(shouldKeepResource).map(mapPath);
  }
  if (value && typeof value === 'object') {
    const mapped = {};
    for (const [source, target] of Object.entries(value)) {
      if (!shouldKeepResource(source)) {
        mapped[source] = null;
        continue;
      }

      const mappedSource = mapPath(source);
      const mappedTarget = mapPath(String(target));
      if (mappedSource !== source) {
        mapped[source] = null;
      }
      mapped[mappedSource] = mappedTarget;
    }
    return mapped;
  }
  return value;
}

const overlay = {
  bundle: {
    targets: ['nsis'],
    // updater 走 NSIS exe 本体 + minisign .sig（无需 Authenticode，
    // windows-support.md §0 核验结论）
    createUpdaterArtifacts: true,
    icon: [
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.ico',
    ],
    resources: mapResources(resources),
    windows: {
      // WebView2 运行时：Win11/新 Win10 自带，但旧 Win10/Server 2019 不带，缺了 app
      // 窗口创建失败秒退（真机实测 Server 2019）。embedBootstrapper 在安装包里嵌 ~2MB
      // 引导器，装机时从微软 CDN 拉运行时（已实测国内可达）；只大 ~2MB，不选
      // offlineInstaller（+150MB）。已装 WebView2 的机器此步秒过。
      webviewInstallMode: { type: 'embedBootstrapper' },
      nsis: {
        // perUser 安装：装到 %LOCALAPPDATA%，安装与每次自动更新都无 UAC
        installMode: 'currentUser',
      },
    },
  },
};

// updater pubkey 注入（CI 提供 TAURI_UPDATER_PUBKEY；base conf 里是
// DISABLED_LOCAL_BUILD 占位，本地预览不注入也能产 overlay）
const updaterPubkey = process.env.TAURI_UPDATER_PUBKEY;
if (updaterPubkey) {
  overlay.plugins = {
    updater: {
      pubkey: updaterPubkey,
      endpoints: process.env.TAURI_UPDATER_ENDPOINT
        ? [process.env.TAURI_UPDATER_ENDPOINT]
        : conf.plugins?.updater?.endpoints,
    },
  };
}

const json = `${JSON.stringify(overlay, null, 2)}\n`;
const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  fs.writeFileSync(process.argv[outIdx + 1], json);
  console.error(`wrote ${target} tauri config overlay → ${process.argv[outIdx + 1]}`);
} else {
  process.stdout.write(json);
}
