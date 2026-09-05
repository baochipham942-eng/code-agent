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
  resolvePostLaunchScoringEnabled,
  type PostLaunchReport,
  type PostLaunchScoringRequest,
  type PostLaunchScoringResult,
} from '../../../shared/contract/postLaunchScore';
import { devSlotFromDataDirName } from '../../../shared/devSlot';
import { getUserDataPath } from '../../platform';
import { getConfigService } from '../../services/core/configService';
import { getDatabase } from '../../services/core/databaseService';
import { createLogger } from '../../services/infra/logger';
import { getQuickModelRuntimeInfo, quickTask } from '../../model/quickModel';
import { isTrustedCalibration, loadCalibrationRecordSync } from '../calibration/calibrationRegistry';
import { loadProjectFailureCodebook } from '../failureCodes';
import { getPostLaunchPromptHash } from '../judge/postLaunchJudge';
import { JUDGE_MAX_TOKENS, estimateJudgeCost } from './postLaunchCost';
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

/**
 * 内部 dogfood 槽判据：数据目录名带 Rust `dev_slot()` 注入的槽身份。
 * 复用产品自己已有的那把尺（`devSlot.ts:99`），它也是 `devModeAutoApprove`
 * 「只在内部槽放行」用的同一个判据（`configService.ts:66`）——同一类决定不该有第二套口径。
 * 它只看数据目录名，所以 CLI 与 Electron 主进程算出来一样。
 */
function isInternalSlot(): boolean {
  try {
    return devSlotFromDataDirName(path.basename(getUserDataPath())) !== null;
  } catch {
    return false;
  }
}

/** 开关三态：显式 on/off 说了算；'auto'（或老配置里没这个键）按槽算。 */
export function isPostLaunchScoringEnabled(): boolean {
  let setting: 'on' | 'off' | 'auto' | undefined;
  try {
    setting = getConfigService().getSettings().privacy?.postLaunchScoring;
  } catch {
    setting = undefined;
  }
  return resolvePostLaunchScoringEnabled(setting, isInternalSlot());
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
    calibration: options.calibration ?? inspectPostLaunchCalibration(path.join(process.cwd(), CONFIG_DIR_NEW)),
  });
}
