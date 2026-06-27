#!/usr/bin/env node
// 校验 Tauri 自动更新器公钥已正确注入构建产物。
//
// 背景：v0.20.0 曾带着源码里的占位符 "DISABLED_LOCAL_BUILD_USE_TAURI_RELEASE_BUNDLE"
// 当作更新器公钥发布，导致已安装客户端下载更新包到 100% 后验签必然失败、永远无法自动更新。
// 根因是发版流程只在「源头」要求 TAURI_UPDATER_PUBKEY，却从不校验「最终二进制」里是否真注入了它。
// 本脚本补上这道产物守卫：构建后断言二进制不含占位符、且含期望公钥，否则发版失败。
//
// 用法：node scripts/verify-updater-pubkey.mjs <binary-path>
//   - <binary-path>：构建产物的主可执行文件
//       macOS:   <App>.app/Contents/MacOS/code-agent-tauri
//       Windows: src-tauri/target/release/code-agent-tauri.exe（NSIS 打包前的原始二进制）
//   - 期望公钥取自环境变量 TAURI_UPDATER_PUBKEY，或 TAURI_UPDATER_PUBKEY_PATH 指向的文件。

import { readFileSync } from 'node:fs';

const PLACEHOLDER = 'DISABLED_LOCAL_BUILD_USE_TAURI_RELEASE_BUNDLE';

function fail(message) {
  console.error(`[verify-updater-pubkey][FAIL] ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[verify-updater-pubkey][OK] ${message}`);
}

const binaryPath = process.argv[2];
if (!binaryPath) {
  fail('用法: node scripts/verify-updater-pubkey.mjs <binary-path>');
}

let expectedPubkey = (process.env.TAURI_UPDATER_PUBKEY ?? '').trim();
if (!expectedPubkey && process.env.TAURI_UPDATER_PUBKEY_PATH) {
  try {
    expectedPubkey = readFileSync(process.env.TAURI_UPDATER_PUBKEY_PATH, 'utf8').replace(/\s+/g, '');
  } catch (err) {
    fail(`无法读取 TAURI_UPDATER_PUBKEY_PATH (${process.env.TAURI_UPDATER_PUBKEY_PATH}): ${err.message}`);
  }
}

let buffer;
try {
  buffer = readFileSync(binaryPath);
} catch (err) {
  fail(`无法读取二进制 ${binaryPath}: ${err.message}`);
}

// 规则 1：占位符必须不存在（无需期望公钥即可执行；v0.20.0 故障就靠这条拦住）。
if (buffer.includes(Buffer.from(PLACEHOLDER, 'utf8'))) {
  fail(
    `二进制仍含更新器公钥占位符 "${PLACEHOLDER}"，说明 TAURI_UPDATER_PUBKEY 未注入此构建；`
    + `该版本的自动更新会验签失败（与 v0.20.0 同类故障）。binary=${binaryPath}`,
  );
}
ok('未发现更新器公钥占位符');

// 规则 2：若提供了期望公钥，二进制必须精确包含它。
if (expectedPubkey) {
  if (expectedPubkey === PLACEHOLDER) {
    fail('TAURI_UPDATER_PUBKEY 被设成了占位符值，等于没有公钥');
  }
  if (!buffer.includes(Buffer.from(expectedPubkey, 'utf8'))) {
    fail(`二进制未包含期望的更新器公钥（TAURI_UPDATER_PUBKEY）。binary=${binaryPath}`);
  }
  ok('已确认注入了期望的更新器公钥');
} else {
  console.warn(
    '[verify-updater-pubkey][WARN] 未提供 TAURI_UPDATER_PUBKEY，仅做了占位符检查；'
    + 'CI 发版务必设置该变量以做精确匹配',
  );
}

ok(`更新器公钥校验通过: ${binaryPath}`);
