/**
 * ADR-010 #1: Swarm CI 健康指标记录器
 *
 * 在 swarm-ci full-suite 成功/失败后调用，维护 ci/swarm-health.json：
 *   - consecutivePasses: 当前连续通过次数（失败时清零）
 *   - longestStreak: 历史最长连续通过次数
 *   - lastRun / lastStatus / history: 审计用
 *
 * 用法：
 *   tsx scripts/ci/record-swarm-health.ts pass  --sha=<sha> --run-id=<id>
 *   tsx scripts/ci/record-swarm-health.ts fail  --sha=<sha> --run-id=<id>
 *
 * 设计取舍（ADR-010 #1 "最简可行"）：
 *   - 为什么选 committed JSON：单文件可 PR 内直接 diff、审计透明、零外部依赖
 *   - 为什么不用 Actions cache：cache 被 GC / 分支切换时会丢，不能长期追踪
 *   - 为什么不用 gist/badge endpoint：多一层 secret/permission，PR 上游审查慢
 *   - 只在 push 到 main 后由 workflow 写回提交（PR 跑 smoke 不触发写回）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_LIMIT = 20;

type Status = 'pass' | 'fail';

interface HealthRecord {
  consecutivePasses: number;
  lastRun: string | null;
  lastStatus: 'unknown' | Status;
  longestStreak: number;
  history: Array<{
    timestamp: string;
    status: Status;
    sha: string;
    runId: string;
    consecutivePasses: number;
  }>;
}

function parseArg(name: string): string {
  const pair = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!pair) return '';
  return pair.slice(name.length + 3);
}

function main(): void {
  const status = process.argv[2];
  if (status !== 'pass' && status !== 'fail') {
    console.error(`usage: record-swarm-health.ts <pass|fail> --sha=<sha> --run-id=<id>`);
    process.exit(2);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const filePath = path.join(repoRoot, 'ci', 'swarm-health.json');

  const raw = readFileSync(filePath, 'utf8');
  const record: HealthRecord = JSON.parse(raw);

  const sha = parseArg('sha') || 'unknown';
  const runId = parseArg('run-id') || 'unknown';
  const timestamp = new Date().toISOString();

  if (status === 'pass') {
    record.consecutivePasses += 1;
    if (record.consecutivePasses > record.longestStreak) {
      record.longestStreak = record.consecutivePasses;
    }
  } else {
    record.consecutivePasses = 0;
  }
  record.lastRun = timestamp;
  record.lastStatus = status;

  record.history.unshift({ timestamp, status, sha, runId, consecutivePasses: record.consecutivePasses });
  if (record.history.length > HISTORY_LIMIT) {
    record.history.length = HISTORY_LIMIT;
  }

  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `swarm-health updated: status=${status} consecutive=${record.consecutivePasses} longest=${record.longestStreak}`,
  );
}

main();
