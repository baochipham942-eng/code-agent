#!/usr/bin/env npx tsx
// ============================================================================
// 上线后评分 CLI（ADR-063 刀 1 · N-EVAL-POSTLAUNCH-K1）
// ----------------------------------------------------------------------------
// 用法：
//   npx tsx scripts/postlaunch-score.ts --days 7 --budget 0.5 --dry-run
//
// --dry-run 只算确定性信号、一次模型都不调，用来先看看这台机器上有多少轮会命中。
// 直接开 SQLite 文件（默认 $CODE_AGENT_DATA_DIR/code-agent.db，未设置则 ~/.code-agent），
// 不启 Electron、不启 DatabaseService——CLI 只需要读遥测表和写分数表。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CONFIG_DIR_NEW } from '../src/shared/constants/configDir';
import { getSettingsPath } from '../src/host/config/configPaths';
import {
  DRY_RUN_JUDGE_VERSION,
  POST_LAUNCH_DEFAULTS,
  POST_LAUNCH_DISABLED_MESSAGE,
  resolvePostLaunchScoringEnabled,
} from '../src/shared/contract/postLaunchScore';
import { resolveModelPrice } from '../src/shared/pricing/resolveModelPrice';
import { getQuickModelRuntimeInfo, quickTask } from '../src/host/model/quickModel';
import { loadProjectFailureCodebook } from '../src/host/testing/failureCodes';
import { TelemetryQueryService } from '../src/host/telemetry/replay/telemetryQueryService';
import { applyTelemetrySchema } from '../src/host/services/core/database/schemaTelemetry';
import { createLogger } from '../src/host/services/infra/logger';
import { getDatabase } from '../src/host/services/core/databaseService';
import { estimateJudgeCost } from '../src/host/testing/postlaunch/postLaunchCost';
import { runPostLaunchScoring, type PostLaunchSessionRow } from '../src/host/testing/postlaunch/postLaunchScorer';
import { buildPostLaunchReport } from '../src/host/testing/postlaunch/postLaunchScoreStore';

function parseArgs(): { days: number; budget: number; sampleLimit: number; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    days: Number(read('--days') ?? POST_LAUNCH_DEFAULTS.days),
    budget: Number(read('--budget') ?? POST_LAUNCH_DEFAULTS.dailyBudgetUsd),
    sampleLimit: Number(read('--sample') ?? POST_LAUNCH_DEFAULTS.dailySampleLimit),
    dryRun: argv.includes('--dry-run'),
  };
}

function resolveDataDir(): string {
  return process.env.CODE_AGENT_DATA_DIR?.trim() || path.join(os.homedir(), CONFIG_DIR_NEW);
}

/** 直接读 settings.json：CLI 不起 ConfigService（那条路要 Electron 的 app 路径）。 */
function readScoringSwitch(): 'on' | 'off' | undefined {
  try {
    const raw = fs.readFileSync(getSettingsPath().user.new, 'utf-8');
    const value = (JSON.parse(raw) as { privacy?: { postLaunchScoring?: unknown } }).privacy?.postLaunchScoring;
    return value === 'on' || value === 'off' ? value : undefined;
  } catch {
    return undefined;
  }
}

function costUsd(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const price = resolveModelPrice(provider, model);
  if (price.inputPerMTok === undefined || price.outputPerMTok === undefined) return 0;
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const dataDir = resolveDataDir();
  const dbPath = path.join(dataDir, 'code-agent.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`找不到数据库 ${dbPath}；设 CODE_AGENT_DATA_DIR 指到要评的那份数据目录。`);
    process.exit(1);
  }
  const db = new Database(dbPath);
  // 已有的库没有本单新表：应用内建表在 schema.ts 启动路径，CLI 直接开库得自己补（IF NOT EXISTS，幂等）
  applyTelemetrySchema(db, createLogger('postlaunch-score'));
  // 回放的证据投影会走 DatabaseService 单例（telemetryReplayEvidence.ts:32），不初始化就每会话报一次「Database not initialized」
  await getDatabase().initialize();
  // 开关三态：CLI 起不了插件运行时，判不了「内部槽」，所以这里按最保守的 false 算默认——
  // 想在 CLI 上评就必须在设置里显式打开（settings.json 的 privacy.postLaunchScoring）。
  if (!options.dryRun && !resolvePostLaunchScoringEnabled(readScoringSwitch(), false)) {
    console.error(POST_LAUNCH_DISABLED_MESSAGE);
    process.exit(1);
  }
  const judge = getQuickModelRuntimeInfo();
  console.log(`库：${dbPath}`);
  console.log(`打分模型：${judge ? `${judge.provider}/${judge.model}` : '未配置'}${options.dryRun ? '（--dry-run，不会调用）' : ''}`);

  const queryService = new TelemetryQueryService({ isReady: true, getDb: () => db } as never);
  const result = await runPostLaunchScoring({
    db,
    getStructuredReplay: (sessionId) => queryService.getStructuredReplay(sessionId),
    llmCall: async (prompt) => {
      const response = await quickTask(prompt, 400);
      if (!response.success || !response.content) throw new Error(response.error ?? '打分模型没有返回内容');
      return { content: response.content, judgeModel: `${response.provider ?? 'unknown'}/${response.model ?? 'unknown'}` };
    },
    estimateJudgeCostUsd: (prompt, completion) => estimateJudgeCost(judge, prompt, completion),
    estimateTurnCostUsd: (session: PostLaunchSessionRow, inputTokens, outputTokens) =>
      costUsd(session.modelProvider, session.modelName, inputTokens, outputTokens),
    fileExists: (absolutePath) => {
      try { return fs.existsSync(absolutePath); } catch { return false; }
    },
    now: () => Date.now(),
    failureCodebook: loadProjectFailureCodebook(),
    onWarn: (message, error) => console.warn(message, error),
  }, {
    days: options.days,
    dailyBudgetUsd: options.budget,
    dailySampleLimit: options.sampleLimit,
    dryRun: options.dryRun,
  });

  console.log(`扫到 ${result.examinedTurns} 轮；剔除 ${result.excludedTurns} 轮（eval/子代理/定时/心跳/脚本发起）`);
  // 这一行说的是「这次叫了几次 judge」，与卡片按周分组那张表的「信号轮 N 轮」不是一回事
  // （后者是那一周落过分数的轮数）。措辞必须自带这个限定，别让两处同名不同义（K1 留给刀 2 第 6 条）。
  console.log(result.dryRun
    ? `dry-run 未调 judge：本可全评的信号轮 ${result.signalTurns}、抽样轮 ${result.sampledTurns}；只记信号 ${result.signalOnlyTurns}；已有分数跳过 ${result.skippedTurns}`
    : `本次调了 judge：信号轮 ${result.signalTurns} / 抽样轮 ${result.sampledTurns}；只记信号（没调 judge）${result.signalOnlyTurns}；已有分数跳过 ${result.skippedTurns}`);
  if (result.locked) console.log('这个库上另有一次评分正在跑（30 分钟内的锁），本次一轮没评、一分没扣；等它跑完再来。');
  if (result.judgeUnavailableTurns > 0) {
    console.log(`⚠️ 打分模型没给出判决的有 ${result.judgeUnavailableTurns} 轮（没配好 / 报错 / 返回读不了），这些轮只记了信号；去设置里配好评分模型再跑。`);
  }
  console.log(`本次打分刊例估算 $${result.costUsd.toFixed(4)}${result.budgetStopped ? '（预算不够下一次调用，当天停评）' : ''}`);

  const report = buildPostLaunchReport(db, { judgeVersion: options.dryRun ? DRY_RUN_JUDGE_VERSION : undefined, days: options.days, dailyBudgetUsd: options.budget, dailySampleLimit: options.sampleLimit });
  for (const group of report.groups) {
    console.log(`\n${group.weekStart} · ${group.appVersion}${group.promptVersion ? ` · ${group.promptVersion}` : ''}`);
    for (const row of group.rows) {
      const dims = Object.entries(row.dims)
        .map(([name, rate]) => `${name} ${rate.judged === 0 ? '—' : `${Math.round((rate.passed / rate.judged) * 100)}%`}`)
        .join('  ');
      console.log(`  ${row.scope === 'signal' ? '信号轮' : '抽样轮'} ${row.turns} 轮：${dims}`);
    }
    if (group.failureClasses.length > 0) {
      console.log(`  失败类别：${group.failureClasses.map((entry) => `${entry.code} ${entry.count}`).join(' · ')}`);
    }
  }
  if (report.calibration.state === 'insufficient') {
    console.log('\n⚠️ 校准不足：这套打分还没跟人工判定对过，分数只能当线索，别当结论。');
  }
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
