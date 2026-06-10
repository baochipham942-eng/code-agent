#!/usr/bin/env node
// ============================================================================
// Windows 构建验证（verify-macos-release.sh 的 win32 等价物，node 实现跨平台）
// ============================================================================
// 用法:
//   node scripts/verify-windows-release.mjs --stage pre   # bundle 前资源齐全检查
//   node scripts/verify-windows-release.mjs --stage post  # bundle 后 NSIS 产物检查
//
// pre：tauri-platform-config 覆盖里引用的每个 win32 资源必须实际存在——
//      缺资源 tauri build 直接失败（x64 先例 v0.16.89），提前在这里给出可读报错。
// post：NSIS setup.exe 存在 + PE 魔数 + （有签名 key 时）updater .sig 存在。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[process.argv.indexOf('--stage') + 1];

const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function existsAt(rel) {
  return fs.existsSync(path.join(root, rel));
}

function verifyPre() {
  console.log('[verify-windows] pre-bundle 资源检查');
  check('dist/bundled-node/node.exe', existsAt('dist/bundled-node/node.exe'));
  check('dist/web/webServer.cjs', existsAt('dist/web/webServer.cjs'));
  check('dist/web/control-plane-public-keys.json', existsAt('dist/web/control-plane-public-keys.json'));
  check('dist/renderer/index.html', existsAt('dist/renderer/index.html'));
  check('dist/native/better-sqlite3 (system-node ABI rebuild)', existsAt('dist/native/better-sqlite3'));
  check('scripts/rtk.exe', existsAt('scripts/rtk.exe'));
  check('scripts/uv.exe', existsAt('scripts/uv.exe'));
  check('node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    existsAt('node_modules/node-pty/prebuilds/win32-x64/conpty.node'));
  check('node_modules/node-pty/prebuilds/win32-x64/pty.node',
    existsAt('node_modules/node-pty/prebuilds/win32-x64/pty.node'));

  const sharpLib = path.join(root, 'node_modules', '@img', 'sharp-win32-x64', 'lib');
  const sharpFiles = fs.existsSync(sharpLib) ? fs.readdirSync(sharpLib) : [];
  check('@img/sharp-win32-x64/lib/*.node', sharpFiles.some((f) => f.endsWith('.node')));
  check('@img/sharp-win32-x64/lib/*.dll (libvips 静态包)', sharpFiles.some((f) => f.endsWith('.dll')),
    'win32 sharp 包应内含 libvips DLL');

  check('node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    existsAt('node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
  check('node_modules/keytar build 产物', existsAt('node_modules/keytar/build/Release/keytar.node')
    || existsAt('node_modules/keytar/prebuilds'));
}

function verifyPost() {
  console.log('[verify-windows] post-bundle NSIS 产物检查');
  const nsisDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const entries = fs.existsSync(nsisDir) ? fs.readdirSync(nsisDir) : [];
  const setupExe = entries.find((f) => f.endsWith('.exe'));
  check('bundle/nsis/*.exe 存在', Boolean(setupExe), `目录内容: ${entries.join(', ') || '(空)'}`);
  if (setupExe) {
    const exePath = path.join(nsisDir, setupExe);
    const header = Buffer.alloc(2);
    const fd = fs.openSync(exePath, 'r');
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    check('PE 魔数 (MZ)', header.toString('ascii') === 'MZ');
    const sizeMb = fs.statSync(exePath).size / 1024 / 1024;
    check(`安装包体积合理 (${sizeMb.toFixed(1)} MB > 30 MB)`, sizeMb > 30,
      '过小说明 webServer/bundled-node/renderer 资源没打进去');
    if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
      check('updater 签名 .sig 存在', entries.some((f) => f.endsWith('.sig')),
        'createUpdaterArtifacts=true 且提供了签名 key，应产 .sig');
    }
  }
}

if (stage === 'pre') {
  verifyPre();
} else if (stage === 'post') {
  verifyPost();
} else {
  console.error('用法: verify-windows-release.mjs --stage <pre|post>');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\n[verify-windows] ${stage} 阶段 ${failures.length} 项失败`);
  process.exit(1);
}
console.log(`\n[verify-windows] ${stage} 阶段全部通过`);
