// ============================================================================
// 上线后打分器的真机接线（N-EVAL-POSTLAUNCH-K1）
// ----------------------------------------------------------------------------
// postLaunchScorer.ts 只认注入进来的 deps，好让单测一个真实服务都不碰。
// 本模块是唯一把它接到真 DB / 真回放 / 真模型 / 真磁盘上的地方。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { CONFIG_DIR_NEW } from '../../../shared/constants/configDir';
import { resolveModelPrice } from '../../../shared/pricing/resolveModelPrice';
import {
  POST_LAUNCH_DISABLED_MESSAGE,
  type PostLaunchReport,
  type PostLaunchScoringRequest,
  type PostLaunchScoringResult,
} from '../../../shared/contract/postLaunchScore';
import { getDatabase } from '../../services/core/databaseService';
import { createLogger } from '../../services/infra/logger';
import { getQuickModelRuntimeInfo, quickTask } from '../../model/quickModel';
import { isTrustedCalibration, loadCalibrationRecordSync } from '../calibration/calibrationRegistry';
import { loadProjectFailureCodebook } from '../failureCodes';
import { getPostLaunchPromptHash } from '../judge/postLaunchJudge';
import { JUDGE_MAX_TOKENS, estimateJudgeCost } from './postLaunchCost';
import { isPostLaunchScoringEnabled } from './postLaunchGate';
import { buildPostLaunchReport, type PostLaunchReportOptions } from './postLaunchScoreStore';
import { runPostLaunchScoring, type PostLaunchScorerDeps, type PostLaunchSessionRow } from './postLaunchScorer';

const logger = createLogger('PostLaunchScorer');

function costUsd(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const price = resolveModelPrice(provider, model);
  // 未知价不编造（resolveModelPrice §2）：拿不到刊例就按 0 记，报告里成本自然是 0 而不是假数。
  if (price.inputPerMTok === undefined || price.outputPerMTok === undefined) return 0;
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

/** 上线后 judge 的校准身份；与发布前各维度的 `<dim>@<judge>` 同形。 */
function postLaunchCalibrationId(judgeIdentity: string): string {
  return `postlaunch@${judgeIdentity}`;
}

function inspectPostLaunchCalibration(registryDir: string): PostLaunchReport['calibration'] {
  const judge = getQuickModelRuntimeInfo();
  const judgeIdentity = judge ? `${judge.provider}/${judge.model}` : 'unavailable';
  const record = loadCalibrationRecordSync(registryDir, postLaunchCalibrationId(judgeIdentity));
  if (record?.standardVersion !== 2) return { state: 'insufficient', reason: 'no_record' };
  if (record.promptHash !== getPostLaunchPromptHash()) return { state: 'insufficient', reason: 'judge_changed' };
  if (!isTrustedCalibration(record)) return { state: 'insufficient', reason: 'below_threshold' };
  return { state: 'calibrated' };
}

function requireDb(): BetterSqlite3.Database {
  const db = getDatabase().getDb();
  if (!db) throw new Error('数据库尚未就绪，无法跑上线后评分');
  return db;
}

function createPostLaunchScorerDeps(): PostLaunchScorerDeps {
  const judge = getQuickModelRuntimeInfo();
  return {
    db: requireDb(),
    getStructuredReplay: async (sessionId: string) => {
      const { getTelemetryQueryService } = await import('../../telemetry/replay/telemetryQueryService');
      return getTelemetryQueryService().getStructuredReplay(sessionId);
    },
    llmCall: async (prompt: string) => {
      const response = await quickTask(prompt, JUDGE_MAX_TOKENS);
      if (!response.success || !response.content) {
        throw new Error(response.error ?? '打分模型没有返回内容');
      }
      return {
        content: response.content,
        judgeModel: `${response.provider ?? 'unknown'}/${response.model ?? 'unknown'}`,
      };
    },
    estimateJudgeCostUsd: (prompt: string, completion?: string) => estimateJudgeCost(judge, prompt, completion),
    estimateTurnCostUsd: (session: PostLaunchSessionRow, inputTokens: number, outputTokens: number) =>
      costUsd(session.modelProvider, session.modelName, inputTokens, outputTokens),
    fileExists: (absolutePath: string) => {
      try {
        return fs.existsSync(absolutePath);
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
    failureCodebook: loadProjectFailureCodebook(),
    onWarn: (message, error) => logger.warn(message, error),
  };
}

export async function runPostLaunchScoringOnHost(
  request: PostLaunchScoringRequest = {},
): Promise<PostLaunchScoringResult> {
  // 关着就不评：这条路会把会话正文发给用户自己配的模型并花他的额度。
  // 已落库的分数照读照显示（getPostLaunchReportOnHost 不受这道门管）。
  if (!isPostLaunchScoringEnabled()) throw new Error(POST_LAUNCH_DISABLED_MESSAGE);
  return runPostLaunchScoring(createPostLaunchScorerDeps(), request);
}

export function getPostLaunchReportOnHost(options: PostLaunchReportOptions = {}): PostLaunchReport {
  return buildPostLaunchReport(requireDb(), {
    ...options,
    // 空提示词 = 一次 judge 调用的成本下限；连它都塞不进上限就是真的停评了。
    reserveUsd: options.reserveUsd ?? estimateJudgeCost(getQuickModelRuntimeInfo(), '').usd,
    calibration: options.calibration ?? inspectPostLaunchCalibration(path.join(process.cwd(), CONFIG_DIR_NEW)),
  });
}
