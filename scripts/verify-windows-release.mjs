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

import { spawnSync } from 'node:child_process';
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

function hasRequiredControlPlanePublicKeys(rel) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    const keys = parsed?.keys && typeof parsed.keys === 'object' ? parsed.keys : {};
    return ['production-2026-05-17', 'production-2026-06-15']
      .every((keyId) => typeof keys[keyId] === 'string' && keys[keyId].trim().length > 0);
  } catch {
    return false;
  }
}

function verifyNativeManifest() {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/verify-native-manifest.mjs'),
    '--root',
    root,
    '--platform',
    'win32-x64',
    '--closure',
  ], { cwd: root, stdio: 'inherit' });
  check('native dependency manifest and closure', result.status === 0);
  return result.status === 0;
}

function verifyBetterSqlite3Load(manifestValid) {
  if (process.platform !== 'win32') {
    console.log('[verify-windows] better-sqlite3 bundled Node load skipped (not Windows)');
    return;
  }
  if (!manifestValid) {
    console.log('[verify-windows] better-sqlite3 bundled Node load skipped (invalid native manifest)');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/native/manifest.json'), 'utf8'));
  const entry = manifest.modules['better-sqlite3'].entry;
  console.log(`[verify-windows] running dist/bundled-node/node.exe -e <better-sqlite3 in-memory DB smoke> ${entry}`);
  const result = spawnSync(path.join(root, 'dist/bundled-node/node.exe'), [
    '-e',
    `
const Database = require(process.argv[1]);
const db = new Database(':memory:');
db.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT)');
db.prepare('INSERT INTO smoke (value) VALUES (?)').run('ok');
const row = db.prepare('SELECT value FROM smoke').get();
db.close();
if (row?.value !== 'ok') throw new Error('in-memory database round trip failed');
console.log('[verify-windows] better-sqlite3 manifest entry loads and opens an in-memory DB with bundled Node');
`,
    path.join(root, entry),
  ], { cwd: root, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  check('better-sqlite3 manifest entry real load and in-memory DB', result.status === 0,
    result.error?.message || `node.exe exited with status ${result.status}`);
}

function verifyPre() {
  console.log('[verify-windows] pre-bundle 资源检查');
  const manifestValid = verifyNativeManifest();
  check('dist/bundled-node/node.exe', existsAt('dist/bundled-node/node.exe'));
  check('dist/web/webServer.cjs', existsAt('dist/web/webServer.cjs'));
  check(
    'dist/web/control-plane-public-keys.json (production compatibility set)',
    hasRequiredControlPlanePublicKeys('dist/web/control-plane-public-keys.json'),
  );
  check('dist/renderer/index.html', existsAt('dist/renderer/index.html'));
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

  check('node_modules/keytar build 产物', existsAt('node_modules/keytar/build/Release/keytar.node')
    || existsAt('node_modules/keytar/prebuilds'));
  verifyBetterSqlite3Load(manifestValid);
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

  // 更新器公钥守卫：打包前的原始 code-agent-tauri.exe 必须含真实公钥、不含占位符。
  // （NSIS setup.exe 内的二进制是压缩的扫不到，所以查 target/release 下的原始 exe；
  //  防 v0.20.0 式“占位符当公钥”导致已安装端下载更新到 100% 后验签失败。）
  const PUBKEY_PLACEHOLDER = 'DISABLED_LOCAL_BUILD_USE_TAURI_RELEASE_BUNDLE';
  const rawExe = path.join(root, 'src-tauri', 'target', 'release', 'code-agent-tauri.exe');
  if (!fs.existsSync(rawExe)) {
    check('原始 exe 存在（供更新器公钥校验）', false, `缺 ${path.relative(root, rawExe)}`);
  } else {
    const bin = fs.readFileSync(rawExe);
    check('更新器公钥非占位符', !bin.includes(Buffer.from(PUBKEY_PLACEHOLDER, 'utf8')),
      'TAURI_UPDATER_PUBKEY 未注入此构建，自动更新会验签失败（v0.20.0 同类故障）');
    const expectedPubkey = (process.env.TAURI_UPDATER_PUBKEY || '').trim();
    if (expectedPubkey && expectedPubkey !== PUBKEY_PLACEHOLDER) {
      check('更新器公钥已注入（精确匹配 TAURI_UPDATER_PUBKEY）',
        bin.includes(Buffer.from(expectedPubkey, 'utf8')),
        '二进制未包含期望的 TAURI_UPDATER_PUBKEY');
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
