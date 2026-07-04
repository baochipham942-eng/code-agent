// ============================================================================
// Baseline Manager — Manages the eval baseline for regression detection
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../config/configPaths';
import { loadNoiseBand } from './noiseBand';
import type { EvalBaseline, BaselineDelta, TestRunSummary, EvalRunMode } from '../types';

/** 分母口径版本：2 = 能力分母排除 skipped 与 infra_excluded（与报告口径一致） */
export const BASELINE_DENOMINATOR_VERSION = 2;

const DEFAULT_THRESHOLDS: EvalBaseline['thresholds'] = {
  minPassRate: 0.7,
  maxScoreDrop: 0.15,
  maxNewFailures: 2,
};

export class BaselineManager {
  private baselinePath: string;

  constructor(private workingDir: string) {
    this.baselinePath = path.join(workingDir, CONFIG_DIR_NEW, 'eval-baseline.json');
  }

  async load(): Promise<EvalBaseline | null> {
    try {
      const content = await fs.readFile(this.baselinePath, 'utf-8');
      return JSON.parse(content) as EvalBaseline;
    } catch {
      return null;
    }
  }

  async save(baseline: EvalBaseline): Promise<void> {
    const dir = path.dirname(this.baselinePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
  }

  async compare(current: TestRunSummary): Promise<BaselineDelta> {
    const baseline = await this.load();

    if (!baseline) {
      return {
        isFirstRun: true,
        passRateDelta: 0,
        scoreDelta: 0,
        newFailures: [],
        newPasses: [],
        isRegression: false,
        regressionDetails: [],
      };
    }

    // 旧版基线（分母含 skipped 口径）只告警不硬拦：下一次 real promote 自然迁移。
    if (baseline.denominatorVersion !== BASELINE_DENOMINATOR_VERSION) {
      console.warn(
        `[baseline] 基线口径较老（denominatorVersion=${baseline.denominatorVersion ?? 1}，当前=${BASELINE_DENOMINATOR_VERSION}）：`
        + '其 passRate 分母未排除 skipped，本次对比在含 skipped 的 run 上可能有偏差；建议尽快重新 promote。',
      );
    }

    // 能力分母 = total − skipped − infra_excluded，与 markdown/HTML 报告口径一致（WP1-2 完整形态）。
    // infra（429/超时/5xx/网络）是环境噪声，skipped 是未执行——都不是能力信号。
    // 与 promote/报告同一 coalesce：显式 infraExcluded 优先（total 允许与 results 数组不一致）
    const currentInfraExcluded = current.infraExcluded
      ?? current.results.filter((r) => r.status === 'infra_excluded').length;
    const currentCapabilityTotal = current.total - current.skipped - currentInfraExcluded;
    const currentPassRate = currentCapabilityTotal > 0 ? current.passed / currentCapabilityTotal : 0;
    const passRateDelta = currentPassRate - baseline.globalMetrics.passRate;
    const scoreDelta = current.averageScore - baseline.globalMetrics.averageScore;

    // Find new failures and new passes
    const newFailures: BaselineDelta['newFailures'] = [];
    const newPasses: BaselineDelta['newPasses'] = [];

    for (const result of current.results) {
      // v1 基线的 caseResults 可能残留 skipped 条目——视同不存在，
      // 与 v2（promote 已不落 skipped）行为一致，避免按基线版本分叉。
      const rawBaselineCase = baseline.caseResults[result.testId];
      const baselineCase = rawBaselineCase?.status === 'skipped' ? undefined : rawBaselineCase;
      const currentStatus = result.status;

      if (baselineCase) {
        if (currentStatus === 'failed' && baselineCase.status !== 'failed') {
          newFailures.push({
            testId: result.testId,
            previousStatus: baselineCase.status,
            currentStatus,
            reason: result.failureReason,
          });
        } else if (currentStatus === 'passed' && baselineCase.status !== 'passed') {
          newPasses.push({ testId: result.testId });
        }
      } else if (currentStatus === 'failed') {
        // New test case that failed
        newFailures.push({
          testId: result.testId,
          previousStatus: 'new',
          currentStatus,
          reason: result.failureReason,
        });
      }
    }

    // Determine regression
    // WP1b：噪声带文件（sweep 实测 2σ）优先于固定 maxScoreDrop=0.15——
    // 固定值比真实噪声宽会漏报回归，比噪声窄会假警报逼人无视门。
    const noiseBand = await loadNoiseBand(this.workingDir);
    const baseThresholds = baseline.thresholds ?? DEFAULT_THRESHOLDS;
    const thresholds = noiseBand
      ? { ...baseThresholds, maxScoreDrop: noiseBand.maxScoreDrop }
      : baseThresholds;
    const regressionDetails: string[] = [];

    if (currentPassRate < thresholds.minPassRate) {
      regressionDetails.push(
        `Pass rate ${(currentPassRate * 100).toFixed(1)}% below minimum ${(thresholds.minPassRate * 100).toFixed(1)}%`,
      );
    }

    if (scoreDelta < -thresholds.maxScoreDrop) {
      regressionDetails.push(
        `Score dropped by ${(-scoreDelta * 100).toFixed(1)}% (max allowed: ${(thresholds.maxScoreDrop * 100).toFixed(1)}%)`,
      );
    }

    if (newFailures.length > thresholds.maxNewFailures) {
      regressionDetails.push(
        `${newFailures.length} new failures (max allowed: ${thresholds.maxNewFailures})`,
      );
    }

    return {
      isFirstRun: false,
      passRateDelta,
      scoreDelta,
      newFailures,
      newPasses,
      isRegression: regressionDetails.length > 0,
      regressionDetails,
    };
  }

  async promote(summary: TestRunSummary, commitSha: string, mode: EvalRunMode = 'real'): Promise<void> {
    // 来源护栏：mock 跑出来的通过率是 adapter 桩的产物，不代表 agent 真实能力，
    // 绝不允许晋升为回归基线。历史上线上 baseline 正是被一次 mock 跑污染过。
    if (mode !== 'real') {
      throw new Error(
        `拒绝将 ${mode} 运行晋升为 baseline：基线必须来自 --real 真实模型执行。` +
        `mock 通过率是确定性桩的产物，不是 agent 能力。`,
      );
    }

    // WP1-2 完整形态：infra_excluded 是「无数据」、skipped 是「未执行」，
    // 都不是结果，都不落 baseline——否则一次限流/一次过滤跑会把幻影状态
    // 写进基线，下次对账全是噪声。分母用 summary 计数（不用 results.length：
    // 调用方的 total 允许与 results 数组不完全一致，见 ci.mode.test 的构造）。
    const capabilityResults = summary.results.filter(
      (r) => r.status !== 'infra_excluded' && r.status !== 'skipped',
    );
    const infraExcluded = summary.infraExcluded
      ?? summary.results.filter((r) => r.status === 'infra_excluded').length;
    const capabilityTotal = summary.total - summary.skipped - infraExcluded;
    const passRate = capabilityTotal > 0 ? summary.passed / capabilityTotal : 0;

    const caseResults: EvalBaseline['caseResults'] = {};
    for (const result of capabilityResults) {
      caseResults[result.testId] = {
        status: result.status,
        score: result.score,
        ...(result.status === 'passed' ? { lastPassedAt: result.endTime } : {}),
      };
    }

    const baseline: EvalBaseline = {
      version: 1,
      denominatorVersion: BASELINE_DENOMINATOR_VERSION,
      updatedAt: Date.now(),
      updatedBy: commitSha,
      mode,
      globalMetrics: {
        passRate,
        averageScore: summary.averageScore,
        totalCases: capabilityTotal,
      },
      caseResults,
      thresholds: DEFAULT_THRESHOLDS,
    };

    await this.save(baseline);
  }
}
