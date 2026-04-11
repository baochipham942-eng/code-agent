// ============================================================================
// Baseline Manager — Manages the eval baseline for regression detection
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../config/configPaths';
import type { EvalBaseline, BaselineDelta, TestRunSummary } from '../types';

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

    const currentPassRate = current.total > 0 ? current.passed / current.total : 0;
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

  async promote(summary: TestRunSummary, commitSha: string): Promise<void> {
    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

    const caseResults: EvalBaseline['caseResults'] = {};
    for (const result of summary.results) {
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
      globalMetrics: {
        passRate,
        averageScore: summary.averageScore,
        totalCases: summary.total,
      },
      caseResults,
      thresholds: DEFAULT_THRESHOLDS,
    };

    await this.save(baseline);
  }
}
