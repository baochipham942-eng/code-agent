#!/usr/bin/env node

// N-SNAPSHOT-REGRESSION：request-replay 快照基线同步门（照 visual-shotbase-baseline-gate
// 的 git-diff 模式）。口径：PR diff 动了模型可见行为面（下方 SENSITIVE_PREFIXES），
// 快照目录 packages/internal/evaluation-center/snapshots/request-replay/ 必须同 PR 有
// 更新（重录：`npm run acceptance:snapshot-replay:record`），否则红。
//
// 敏感面清单的选取口径：凡是能改变「发给假模型的字节」或「假模型响应字节」或
// 「重建/比对语义」的代码——contextAssembly 的拼装/哈希、prompts 文案、E2E 假模型
// 路由、requestReplay 的重建与比对。快照目录自身的改动天然不算敏感变更；
// docs-only PR 不碰敏感面前缀，天然豁免。
//
// 已知边界（与 visual 门不同，这里不做 token 级契约比对）：注释/重命名类行为不可见
// 的敏感面改动也会触发本门。逃生舱：重录确认字节无漂移后，在
// snapshots/request-replay/README.md「重录确认」节追加一行说明（即构成同 PR
// 快照目录更新）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '../..');
const snapshotDir = 'packages/internal/evaluation-center/snapshots/request-replay';

// 模型可见行为面：改动这些路径 = 可能改变发给模型的字节 / 假模型响应 / 重建语义。
const SENSITIVE_PREFIXES = [
  'src/host/agent/runtime/contextAssembly/',
  'src/host/prompts/',
  'src/host/testing/e2e/',
  'packages/internal/evaluation-center/src/host/evaluation/requestReplay.ts',
  'packages/internal/evaluation-center/src/host/evaluation/requestReplayGate.ts',
];

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const knownArgs = new Set(['--repo-root', '--base-ref']);
const unknownArgs = args.filter((arg, index) => arg.startsWith('--')
  ? !knownArgs.has(arg)
  : index === 0 || !knownArgs.has(args[index - 1]));
if (unknownArgs.length > 0) {
  console.error(`[snapshot-replay-sync-gate] ✗ 不支持的参数：${unknownArgs.join(', ')}`);
  process.exit(1);
}

const repoRoot = path.resolve(option('--repo-root', defaultRepoRoot));
const baseRef = option('--base-ref', process.env.SNAPSHOT_REPLAY_SYNC_BASE_REF || 'origin/main');

function fail(message) {
  console.error(`[snapshot-replay-sync-gate] ✗ ${message}`);
  process.exit(1);
}

function git(argsList) {
  try {
    return execFileSync('git', argsList, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    fail(`git ${argsList.join(' ')} 失败${stderr ? `：${stderr}` : ''}`);
  }
}

function lines(value) {
  return value ? value.split('\n').filter(Boolean) : [];
}

/**
 * 与 visual 门同口径：merge-base 以来的提交 diff + 工作树未提交改动 + 未跟踪文件。
 * diff-filter 含 D：删掉敏感面文件同样是模型可见行为变更（ai-review #1721 Nit 1
 * 首踩——ACMR 漏 D，删 contextAssembly 文件不触发同步要求）。删除快照目录自身
 * 不触发敏感面判定（快照路径不在 SENSITIVE_PREFIXES），只受「语料非空」 fail-loud 守。
 */
function changedPathsSince(ref) {
  const changed = new Set(lines(git(['diff', '--name-only', '--diff-filter=ACMRD', ref])));
  for (const pending of lines(git(['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD']))) {
    changed.add(pending);
  }
  for (const staged of lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']))) {
    changed.add(staged);
  }
  for (const untracked of lines(git(['ls-files', '--others', '--exclude-standard']))) {
    changed.add(untracked);
  }
  return changed;
}

git(['rev-parse', '--show-toplevel']);
const baseSha = git(['merge-base', 'HEAD', baseRef]);
if (!baseSha) fail(`HEAD 与 ${baseRef} 的 merge-base 为空`);

// 门不许空转：快照目录必须存在且至少有一条含 index.json 的用例。
const absoluteSnapshotDir = path.join(repoRoot, snapshotDir);
let caseDirs;
try {
  caseDirs = fs.readdirSync(absoluteSnapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && fs.existsSync(path.join(absoluteSnapshotDir, entry.name, 'index.json')))
    .map((entry) => entry.name);
} catch (error) {
  fail(`读取快照目录 ${snapshotDir} 失败：${error instanceof Error ? error.message : String(error)}`);
}
if (caseDirs.length === 0) {
  fail(`快照目录 ${snapshotDir} 没有任何用例——先跑 npm run acceptance:snapshot-replay:record 建语料`);
}

const changed = changedPathsSince(baseSha);
const sensitiveChanged = [...changed].filter((file) => (
  SENSITIVE_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))
));
const snapshotChanged = [...changed].filter((file) => file.startsWith(`${snapshotDir}/`));

if (sensitiveChanged.length > 0 && snapshotChanged.length === 0) {
  fail(
    `改了模型可见行为面但没同 PR 重录 request-replay 快照。敏感变更：${sensitiveChanged.join(', ')}。`
    + '请跑 npm run acceptance:snapshot-replay:record 并把快照diff随本 PR 提交；'
    + '若确认改动行为不可见（注释/重命名），重录确认零漂移后在 '
    + `${snapshotDir}/README.md 的「重录确认」节追加一行说明。`,
  );
}

console.log(
  `[snapshot-replay-sync-gate] ✓ 快照基线与模型可见行为面同步（base=${baseSha.slice(0, 10)}，`
  + `敏感变更 ${sensitiveChanged.length} 个，快照变更 ${snapshotChanged.length} 个，用例 ${caseDirs.length} 条）`,
);
