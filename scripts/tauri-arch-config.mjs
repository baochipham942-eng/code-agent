#!/usr/bin/env node
// ============================================================================
// 从 src-tauri/tauri.conf.json 派生指定架构的 bundle.resources 覆盖配置。
// ============================================================================
// 背景：tauri.conf.json 的 bundle.resources 写死了 arm64 的 native 路径
//   （node-pty/prebuilds/darwin-arm64、@img/sharp-darwin-arm64、sharp-libvips-darwin-arm64）。
//   Tauri 没有 arch 模板，x64 构建需要把这些路径换成 darwin-x64。
//
// 用法：
//   node scripts/tauri-arch-config.mjs <arm64|x64> [--out <path>]
//   # x64 构建：
//   node scripts/tauri-arch-config.mjs x64 --out /tmp/tauri.x64.json
//   cargo tauri build --config /tmp/tauri.x64.json
//
// 说明：
//   - Tauri 的 --config 对数组是「替换」语义，故覆盖里必须给全量 resources，
//     从 base 派生（而非另存一份 x64 配置）避免两边漂移。
//   - 只改 arch 相关路径；rtk/uv/swift/better-sqlite3/keytar 等路径与架构无关
//     （文件内容由各自 x64 构建步骤产出，路径不变）。
//   - rtk 在 x64 照常打包（已决策带上 x64），路径不变，无需特殊处理。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arch = process.argv[2];
if (arch !== 'arm64' && arch !== 'x64') {
  console.error('用法: tauri-arch-config.mjs <arm64|x64> [--out <path>]');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const resources = Array.isArray(conf.bundle?.resources) ? conf.bundle.resources : [];

// arch 相关路径全部含 `darwin-arm64` 子串（node-pty prebuild / sharp / sharp-libvips），
// 一次替换即覆盖全部三类；arm64 时原样返回（base 即 arm64）。
function mapEntry(entry) {
  return arch === 'x64' ? entry.replaceAll('darwin-arm64', 'darwin-x64') : entry;
}

const overlay = { bundle: { resources: resources.map(mapEntry) } };
const json = `${JSON.stringify(overlay, null, 2)}\n`;

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  fs.writeFileSync(process.argv[outIdx + 1], json);
  console.error(`wrote ${arch} tauri config overlay → ${process.argv[outIdx + 1]}`);
} else {
  process.stdout.write(json);
}
