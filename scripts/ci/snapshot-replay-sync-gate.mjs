#!/usr/bin/env node

// N-SNAPSHOT-REGRESSION：request-replay 快照基线同步门（照 visual-shotbase-baseline-gate
// 的 git-diff 模式）。口径：PR diff 动了模型可见行为面（下方 SENSITIVE_PREFIXES），
// 快照目录 packages/internal/evaluation-center/snapshots/request-replay/ 必须同 PR 有
// 更新（重录：`npm run acceptance:snapshot-replay:record`），否则红。
//
// 算进「快照更新」的有三层文件：协议层用例目录（canonical-request 等）、
// 渲染层旁路 `<case>.render.json`、持久层旁路 `<case>.state.json`。后两类与用例
// 目录同级，由同一次 record 写出。三层用例 write-file 缺任一旁路即红——旁路不算
// 可有可无的附件。
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
// 已钉三层证据的用例。旁路文件与用例目录同级：<case>.render.json / <case>.state.json。
const THREE_LAYER_CASES = ['write-file'];
const RENDER_SIDECAR_SUFFIX = '.render.json';
const STATE_SIDECAR_SUFFIX = '.state.json';

// 模型可见行为面：改动这些路径 = 可能改变发给模型的字节 / 假模型响应 / 重建语义。
// readResultProjection.ts 单列出文件而非整目录：src/host/context/ 下其余模块不进
// 请求拼装；该文件决定重复 Read 结果在模型可见投影里去重成回执还是保留全文
// （N-SNAPSHOT-CORPUS-READDEDUPE 实证：变异它回放层不红，只能靠本门强制同 PR 重录）。
// contextBuilder.ts：runtime mode、工作目录规则和 <env> 块进入系统提示。
// converter.ts：formatToolCallForHistory 拼出的 Called 文本进入后续轮消息。
// toolDefinitions.ts：延迟工具摘要里的 unlisted 行进入系统提示。
// deferredTools.ts：延迟工具名字索引进入 <deferred-tools>。
// todayAnchor.ts：「今天的日期」句式进入系统提示。
// src/host/tools/modules/**/*.schema.ts：核心工具的 description 与 inputSchema 进入 canonicalTools。
const SENSITIVE_PREFIXES = [
  'src/host/agent/runtime/contextAssembly/',
  'src/host/context/readResultProjection.ts',
  'src/host/prompts/',
  'src/host/testing/e2e/',
  'packages/internal/evaluation-center/src/host/evaluation/requestReplay.ts',
  'packages/internal/evaluation-center/src/host/evaluation/requestReplayGate.ts',
  'src/host/agent/messageHandling/contextBuilder.ts',
  'src/host/agent/messageHandling/converter.ts',
  'src/host/tools/dispatch/toolDefinitions.ts',
  'src/host/services/toolSearch/deferredTools.ts',
  'src/shared/todayAnchor.ts',
];

// schema 与实现文件相邻。敏感面只含 modules 下以 .schema.ts 结尾的路径。
const TOOL_SCHEMA_DIR = 'src/host/tools/modules/';
const TOOL_SCHEMA_SUFFIX = '.schema.ts';

function isModelVisiblePath(file) {
  if (SENSITIVE_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))) {
    return true;
  }
  return file.startsWith(TOOL_SCHEMA_DIR) && file.endsWith(TOOL_SCHEMA_SUFFIX);
}

function snapshotLayer(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base.endsWith(RENDER_SIDECAR_SUFFIX)) return 'render';
  if (base.endsWith(STATE_SIDECAR_SUFFIX)) return 'state';
  return 'protocol';
}

/** 协议层语料、渲染层旁路、持久层旁路都算快照更新。 */
function isSnapshotSyncPath(file) {
  if (!file.startsWith(`${snapshotDir}/`)) return false;
  const layer = snapshotLayer(file);
  return layer === 'protocol' || layer === 'render' || layer === 'state';
}

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

for (const caseId of THREE_LAYER_CASES) {
  if (!caseDirs.includes(caseId)) {
    fail(`三层回放用例 ${caseId} 不在快照语料里`);
  }
  for (const suffix of [RENDER_SIDECAR_SUFFIX, STATE_SIDECAR_SUFFIX]) {
    const relativePath = `${snapshotDir}/${caseId}${suffix}`;
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      fail(
        `三层回放旁路缺失：${relativePath}。`
        + '跑 npm run acceptance:snapshot-replay:record，让渲染层与持久层跟协议层一起落盘。',
      );
    }
  }
}

const changed = changedPathsSince(baseSha);
const sensitiveChanged = [...changed].filter((file) => isModelVisiblePath(file));
const snapshotChanged = [...changed].filter((file) => isSnapshotSyncPath(file));
const renderChanged = snapshotChanged.filter((file) => file.endsWith(RENDER_SIDECAR_SUFFIX));
const stateChanged = snapshotChanged.filter((file) => file.endsWith(STATE_SIDECAR_SUFFIX));

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
  + `敏感变更 ${sensitiveChanged.length} 个，快照变更 ${snapshotChanged.length} 个`
  + `（渲染 ${renderChanged.length}，持久 ${stateChanged.length}），`
  + `用例 ${caseDirs.length} 条，三层旁路 ${THREE_LAYER_CASES.join(',')} 齐全）`,
);
