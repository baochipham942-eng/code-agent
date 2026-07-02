// ============================================================================
// Baseline Manager — Manages the eval baseline for regression detection
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../config/configPaths';
import type { EvalBaseline, BaselineDelta, TestRunSummary, EvalRunMode } from '../types';

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

    // WP1-2：infra_excluded（429/超时/5xx/网络）不进能力分母——环境噪声不是能力回归
    const currentInfraExcluded = current.results.filter((r) => r.status === 'infra_excluded').length;
    const currentCapabilityTotal = current.total - currentInfraExcluded;
    const currentPassRate = currentCapabilityTotal > 0 ? current.passed / currentCapabilityTotal : 0;
    const passRateDelta = currentPassRate - baseline.globalMetrics.passRate;
    const scoreDelta = current.averageScore - baseline.globalMetrics.averageScore;

    // Find new failures and new passes
    const newFailures: BaselineDelta['newFailures'] = [];
    const newPasses: BaselineDelta['newPasses'] = [];

    for (const result of current.results) {
      const baselineCase = baseline.caseResults[result.testId];
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
    const thresholds = baseline.thresholds ?? DEFAULT_THRESHOLDS;
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

    // WP1-2：infra_excluded 是「无数据」不是结果，不落 baseline——
    // 否则一次限流会把幻影状态写进基线，下次对账全是噪声。
    // 分母用 summary.total - infra 计数（不用 results.length：调用方的
    // total 允许与 results 数组不完全一致，见 ci.mode.test 的构造）。
    const capabilityResults = summary.results.filter((r) => r.status !== 'infra_excluded');
    const infraExcluded = summary.infraExcluded
      ?? (summary.results.length - capabilityResults.length);
    const capabilityTotal = summary.total - infraExcluded;
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
