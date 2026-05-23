#!/usr/bin/env node
// 冒烟：构建出的 CLI 产物必须能被 node 正常加载并响应 --version / --help。
//
// 背景（2026-05-20 回归）：commit 7a8bd57e "close architecture debt refactors" 在
// src/cli/{database,bootstrap}.ts 引入裸 `Module.createRequire(import.meta.url)`，
// esbuild 打 CJS 时把 import.meta 替换成 {} → import.meta.url=undefined →
// `createRequire(undefined)` 在加载时直接抛错，CLI `--help` 都跑不起来。
// dev 用 tsx 跑 ESM 测不出来，没人跑构建产物所以坏了 3 天才被发现。
//
// 这个 smoke 直接跑 dist/cli/index.cjs，是该回归类的最后一道闸：
//   - load-time crash（createRequire/import.meta、顶层副作用抛错）
//   - bin 入口 commander 解析挂掉
// 只验证入口可加载，不打 LLM、不写数据。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const distCli = path.join(__dirname, '..', 'dist', 'cli', 'index.cjs');

if (!fs.existsSync(distCli)) {
  console.error('FAIL: dist/cli/index.cjs 不存在，请先 npm run build:cli');
  process.exit(1);
}

function run(args) {
  const res = spawnSync(process.execPath, [distCli, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    // 不继承 TTY，避免 chat 命令的交互分支；--version/--help 是纯输出即退出
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return res;
}

let failed = false;

// 1) --version：应 exit 0 并打印形如 x.y.z 的版本号
const version = run(['--version']);
const versionOut = `${version.stdout || ''}${version.stderr || ''}`.trim();
const versionOk = version.status === 0 && /\d+\.\d+\.\d+/.test(versionOut);
console.log(`[1/2] --version exit=${version.status} out="${versionOut.slice(0, 40)}" → ${versionOk ? 'OK' : 'FAIL'}`);
if (!versionOk) {
  failed = true;
  if (version.error) console.error('  spawn error:', version.error.message);
  if (version.stderr) console.error('  stderr:', version.stderr.slice(0, 500));
}

// 2) --help：应 exit 0 且不含 createRequire/import.meta 类 load-time 崩溃栈
const help = run(['--help']);
const helpOut = `${help.stdout || ''}${help.stderr || ''}`;
const crashed = /createRequire|ERR_INVALID_ARG_VALUE|import\.meta/.test(helpOut);
const helpOk = help.status === 0 && helpOut.includes('code-agent') && !crashed;
console.log(`[2/2] --help exit=${help.status} crashed=${crashed} → ${helpOk ? 'OK' : 'FAIL'}`);
if (!helpOk) {
  failed = true;
  if (help.stderr) console.error('  stderr:', help.stderr.slice(0, 500));
}

if (failed) {
  console.error('\nFAIL: CLI 入口 smoke 未通过 —— 构建产物加载/解析异常。');
  process.exit(1);
}
console.log('\nPASS: CLI 入口可正常加载并响应 --version/--help。');
process.exit(0);
