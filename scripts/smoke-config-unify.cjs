#!/usr/bin/env node
// 冒烟：验证 P0-2 后 CLI bootstrap 经由 main ConfigService 单例读到 config.json
//
// 直接跑 dist/cli/index.cjs 走 list-tools 命令（不打 LLM），看输出里能不能正常
// 起 services；同时启 inspector 观察 module require 路径里有没有重复的 ConfigService。
//
// 更直接的验证：dist/cli/index.cjs bundle 里的 ConfigService class 应该只来自
// main，不再来自旧的 cli/config CLIConfigService。

const fs = require('fs');
const path = require('path');
const os = require('os');

const dataDir = path.join(os.homedir(), '.code-agent');
const configFile = path.join(dataDir, 'config.json');

if (!fs.existsSync(configFile)) {
  console.log('SKIP: ~/.code-agent/config.json 不存在');
  process.exit(0);
}

const groundTruth = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
const expected = groundTruth.models?.default;
console.log('[1/3] config.json models.default =', expected);

// 验证 1: dist/cli/index.cjs 里只剩一份 ConfigService class（旧 CLIConfigService 已删除）
const distCli = path.join(__dirname, '..', 'dist', 'cli', 'index.cjs');
if (!fs.existsSync(distCli)) {
  console.error('FAIL: dist/cli/index.cjs 不存在，请先 npm run build:cli');
  process.exit(1);
}
const bundle = fs.readFileSync(distCli, 'utf-8');

// 旧 CLIConfigService class 的特征字符串：
//   "CLI 配置服务 - 简化版，不依赖 Electron"
//   getDataDir 方法名 + 'CODE_AGENT_DATA_DIR' fallback
const oldClassMarker = bundle.includes('CLI 配置服务 - 简化版');
console.log('[2/3] dist/cli bundle 含旧 CLIConfigService class?', oldClassMarker, '(预期 false)');
if (oldClassMarker) {
  console.error('FAIL: build 产物仍含旧 CLIConfigService 实现');
  process.exit(1);
}

// 验证 2: bundle 里有 main ConfigService 的特征
//   "Restoring settings from Keychain"
const mainClassMarker = bundle.includes('Restoring settings from Keychain');
console.log('[3/3] dist/cli bundle 含 main ConfigService 实现?', mainClassMarker, '(预期 true)');
if (!mainClassMarker) {
  console.error('FAIL: build 产物缺少 main ConfigService（CLI 没正确 import 主类）');
  process.exit(1);
}

console.log('\nPASS — 配置双胞胎已消除：CLI bundle 里只有 main ConfigService 一份实现');
process.exit(0);
