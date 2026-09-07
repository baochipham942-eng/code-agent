#!/usr/bin/env npx tsx

// N-SNAPSHOT-REGRESSION（DSH P1-M2）：request-replay 快照回归门。
//   默认模式（回放，keyless，可进 PR CI）：读 snapshots/request-replay 下每条
//     用例，用当前代码重建请求 + 重推导假模型响应，与快照逐字节比对。
//   --record（重录）：跑一批 CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1 确定性假模型
//     真会话（StandaloneAgentAdapter），把每轮 request manifest + canonical
//     request + 假模型 canonical 响应覆写进快照目录。
// 重录纪律由 scripts/ci/snapshot-replay-sync-gate.mjs 守：动模型可见行为必须
// 同 PR 更新快照。
//
// ⚠ 本文件顶层只许 import node 内置与 snapshot-replay-cases：host 侧的
// databaseService/appPaths 在 import 期就按 env 缓存数据目录，record 模式的
// CODE_AGENT_DATA_DIR 必须先于一切 host 模块落定（2026-09-07 首踩：静态 import
// 抢跑，录制材料落进真实 ~/.code-agent）。

import { readdirSync } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

import {
  planSnapshotRecordDataDir,
} from '../lib/snapshot-replay-cases';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.resolve(scriptDir, '../../snapshots/request-replay');

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const recordMode = hasFlag('--record');
const recordDataDir = recordMode ? planSnapshotRecordDataDir() : null;
if (recordMode && recordDataDir) {
  // 先设 env，再碰任何 host 模块（含 snapshotReplay 核心模块的 import 链）。
  // 每用例的 READ/WRITE 夹具路径由 record 循环在跑该用例前写入 process.env
  // （假模型在调用期读 env），这里只落定进程级共享项。
  process.env.CODE_AGENT_DATA_DIR = recordDataDir;
  process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL = '1';
}

const {
  replaySnapshotCase,
  SnapshotReplayMismatchError,
} = await import('../../src/host/evaluation/snapshotReplay');

function listCaseDirs(): string[] {
  let entries;
  try {
    entries = readdirSync(corpusDir, { withFileTypes: true });
  } catch (error) {
    throw new SnapshotReplayMismatchError(
      `快照语料目录不可读：${corpusDir}（${error instanceof Error ? error.message : String(error)}）。`
      + '门不许空转——语料丢失必须红，先跑 npm run acceptance:snapshot-replay:record 重建。',
    );
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (dirs.length === 0) {
    throw new SnapshotReplayMismatchError(
      `快照语料目录为空：${corpusDir}。门不许空转，先跑 npm run acceptance:snapshot-replay:record 重建。`,
    );
  }
  return dirs;
}

function runReplay(): void {
  const results = [];
  for (const caseName of listCaseDirs()) {
    const result = replaySnapshotCase(path.join(corpusDir, caseName));
    results.push(result);
    console.log(
      `  ✓ ${result.caseId}: ${result.verified} 轮咬字节通过`
      + (result.skippedDegraded > 0 ? `，跳过 ${result.skippedDegraded} 轮 degraded` : ''),
    );
  }
  const verified = results.reduce((sum, result) => sum + result.verified, 0);
  const skippedDegraded = results.reduce((sum, result) => sum + result.skippedDegraded, 0);
  if (verified === 0) {
    throw new SnapshotReplayMismatchError('快照回放 0 轮通过（全 degraded 或空语料）——门不许空转。');
  }
  console.log(
    `snapshot replay passed: ${results.length} 条会话 ${verified} 轮逐字节一致`
    + (skippedDegraded > 0 ? `，${skippedDegraded} 轮 degraded 按口径跳过` : '，无 degraded 轮'),
  );
}

async function main(): Promise<void> {
  if (!recordMode) {
    runReplay();
    return;
  }
  const { recordSnapshotCorpus } = await import('./snapshot-replay-record');
  await recordSnapshotCorpus({
    corpusDir,
    dataDir: recordDataDir!,
    keepTmp: hasFlag('--keep-tmp') || process.env.CODE_AGENT_ACCEPTANCE_KEEP_TMP === '1',
  });
}

// 与 real-agent-replay-eval-smoke 同因（N-EVAL-CI-NOEXIT）：record 模式的数据库/
// 遥测常驻句柄排不空事件循环，活干完先排空 stdout 再退。
main().then(() => {
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
