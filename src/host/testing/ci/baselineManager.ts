// ============================================================================
// Baseline Manager — Manages the eval baseline for regression detection
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG_DIR_NEW } from '../../config/configPaths';
import { loadNoiseBand } from './noiseBand';
import type {
  EvalBaseline,
  BaselineDelta,
  ComparableBaselineDelta,
  TestRunSummary,
  EvalRunMode,
} from '../types';

/** 通过率规则版本：4 = 计划题集一等字段，not_run 保留在通过率内。 */
export const BASELINE_DENOMINATOR_VERSION = 4;

const DEFAULT_THRESHOLDS: EvalBaseline['thresholds'] = {
  minPassRate: 0.7,
  maxScoreDrop: 0.15,
  maxNewFailures: 2,
};

const MOCK_HARNESS_THRESHOLDS: EvalBaseline['thresholds'] = {
  minPassRate: 1,
  maxScoreDrop: 0,
  maxNewFailures: 0,
};

interface BaselineManagerOptions {
  kind?: 'agent' | 'mock-harness';
}

export class BaselineManager {
  private baselinePath: string;
  private kind: 'agent' | 'mock-harness';

  constructor(private workingDir: string, options: BaselineManagerOptions = {}) {
    this.kind = options.kind ?? 'agent';
    this.baselinePath = this.kind === 'mock-harness'
      ? path.join(workingDir, '.claude', 'eval-mock-baseline.json')
      : path.join(workingDir, CONFIG_DIR_NEW, 'eval-baseline.json');
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
    const currentNotRun = Math.max(
      current.notRun,
      current.results.filter((result) => result.status === 'not_run').length,
    );
    const currentInvalidCases = Math.max(
      current.invalidCases,
      current.results.filter((result) => result.invalid !== undefined).length,
    );
    if (!current.completed || currentNotRun > 0 || current.aborted) {
      return {
        comparable: false,
        reason: `本轮未跑满（${currentNotRun} 题未跑），不与基准比较`,
      };
    }
    if (currentInvalidCases > 0) {
      return {
        comparable: false,
        reason: `本轮有 ${currentInvalidCases} 道无效题（没调真模型），不与基准比较`,
      };
    }

    const baseline = await this.load();

    if (!baseline) {
      return {
        comparable: true,
        isFirstRun: true,
        passRateDelta: 0,
        scoreDelta: 0,
        newFailures: [],
        newPasses: [],
        isRegression: false,
        regressionDetails: [],
      };
    }

    const baselinePlanned = new Set(baseline.plannedCaseIds ?? []);
    const currentPlanned = new Set(current.plannedCaseIds);
    const planMismatch = baselinePlanned.size !== currentPlanned.size
      || current.plannedCaseIds.some((id) => !baselinePlanned.has(id));
    if (planMismatch) {
      return { comparable: false, reason: '本轮计划题集与基准不一致，不与基准比较' };
    }

    if (baseline.denominatorVersion !== BASELINE_DENOMINATOR_VERSION) {
      return {
        comparable: false,
        reason: '基线口径较老，请重新设为对比基准',
      };
    }

    // 通过率 = passed / (planned − skipped − infra_excluded − cost_exceeded)。
    // not_run 留在计划题数内；429/5xx/网络是环境噪声。
    // 与 promote/报告同一 coalesce：显式 infraExcluded 优先（total 允许与 results 数组不一致）
    const currentInfraExcluded = current.infraExcluded
      ?? current.results.filter((r) => r.status === 'infra_excluded').length;
    const currentCostExceeded = current.costExceeded
      ?? current.results.filter((result) => result.status === 'cost_exceeded').length;
    const currentCapabilityTotal =
      current.total - current.skipped - currentInfraExcluded - currentCostExceeded;
    const currentPassRate = currentCapabilityTotal > 0 ? current.passed / currentCapabilityTotal : 0;
    const passRateDelta = currentPassRate - baseline.globalMetrics.passRate;
    const scoreDelta = current.averageScore - baseline.globalMetrics.averageScore;

    // Find new failures and new passes
    const newFailures: ComparableBaselineDelta['newFailures'] = [];
    const newPasses: ComparableBaselineDelta['newPasses'] = [];

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
      comparable: true,
      isFirstRun: false,
      passRateDelta,
      scoreDelta,
      newFailures,
      newPasses,
      isRegression: regressionDetails.length > 0,
      regressionDetails,
    };
  }

  async promote(
    summary: TestRunSummary,
    commitSha: string,
    mode: EvalRunMode,
    expectedCaseIds: string[],
  ): Promise<void> {
    if (!expectedCaseIds || expectedCaseIds.length === 0) {
      throw new Error('拒绝设为对比基准：缺少本轮加载到的评测集全集');
    }
    // 来源护栏：mock 跑出来的通过率是 adapter 桩的产物，不代表 agent 真实能力，
    // 绝不允许晋升为回归基线。历史上线上 baseline 正是被一次 mock 跑污染过。
    if (mode !== 'real') {
      throw new Error(
        `拒绝将 ${mode} 运行晋升为 baseline：基线必须来自 --real 真实模型执行。` +
        `mock 通过率是确定性桩的产物，不是 agent 能力。`,
      );
    }

    const rejectionReasons: string[] = [];
    const addCaseReasons = (
      label: string,
      declaredCount: number,
      predicate: (result: TestRunSummary['results'][number]) => boolean,
      reason: (result: TestRunSummary['results'][number]) => string,
    ) => {
      const cases = summary.results.filter(predicate);
      if (cases.length > 0) {
        rejectionReasons.push(`${label}: ${cases.map((result) => `${result.testId}（${reason(result)}）`).join(', ')}`);
      } else if (declaredCount > 0) {
        rejectionReasons.push(`${label}: 汇总记录 ${declaredCount} 题，但缺少题级原因`);
      }
    };

    if (!summary.completed) rejectionReasons.push('本轮未跑满（completed=false）');
    addCaseReasons('未跑', summary.notRun, (result) => result.status === 'not_run', (result) => result.failureReason ?? '轮次中断');
    addCaseReasons('跳过', summary.skipped, (result) => result.status === 'skipped', (result) => result.failureReason ?? '未说明');
    addCaseReasons('环境故障', summary.infraExcluded ?? 0, (result) => result.status === 'infra_excluded', (result) => result.failureReason ?? '未说明');
    addCaseReasons('成本超限', summary.costExceeded ?? 0, (result) => result.status === 'cost_exceeded', (result) => result.failureReason ?? '未说明');
    addCaseReasons('无效题（没调真模型）', summary.invalidCases, (result) => result.invalid !== undefined, (result) => result.invalid?.reason ?? '未说明');

    const planned = new Set(summary.plannedCaseIds);
    const expected = new Set(expectedCaseIds);
    const resultIds = new Set(summary.results.map((result) => result.testId));
    const missing = expectedCaseIds.filter((id) => !planned.has(id));
    const unexpected = summary.plannedCaseIds.filter((id) => !expected.has(id));
    if (missing.length > 0 || unexpected.length > 0) {
      rejectionReasons.push(
        `计划题集不是本轮评测集全集`
        + `${missing.length > 0 ? `；缺少: ${missing.join(', ')}` : ''}`
        + `${unexpected.length > 0 ? `；多出: ${unexpected.join(', ')}` : ''}`,
      );
    }
    const missingResults = summary.plannedCaseIds.filter((id) => !resultIds.has(id));
    if (missingResults.length > 0) {
      rejectionReasons.push(`计划题集缺少结果: ${missingResults.join(', ')}`);
    }
    if (rejectionReasons.length > 0) {
      throw new Error(`拒绝设为对比基准：${rejectionReasons.join('；')}`);
    }

    // WP1-2 完整形态：infra_excluded 是「无数据」、skipped 是「未执行」，
    // 都不是结果，都不落 baseline——否则一次限流/一次过滤跑会把幻影状态
    // 写进基线，下次对账全是噪声。分母用 summary 计数（不用 results.length：
    // 调用方的 total 允许与 results 数组不完全一致，见 ci.mode.test 的构造）。
    const capabilityResults = summary.results.filter(
      (result) =>
        result.status !== 'infra_excluded'
        && result.status !== 'skipped'
        && result.status !== 'cost_exceeded'
        && result.status !== 'not_run'
        && result.invalid === undefined,
    );
    const infraExcluded = summary.infraExcluded
      ?? summary.results.filter((r) => r.status === 'infra_excluded').length;
    const costExceeded = summary.costExceeded
      ?? summary.results.filter((result) => result.status === 'cost_exceeded').length;
    const capabilityTotal = summary.total - summary.skipped - infraExcluded - costExceeded;
    const passRate = capabilityTotal > 0 ? summary.passed / capabilityTotal : 0;

    // per-case 模型归因（费曼审计 P1-4 顺带项）：TestResult 尚无逐 case 模型字段，
    // 先落 run 级 environment 的 provider/model——已足够把「这套分数是谁跑出来的」钉进基线
    const runModel = summary.environment?.model
      ? `${summary.environment.provider}/${summary.environment.model}`
      : undefined;
    const caseResults: EvalBaseline['caseResults'] = {};
    for (const result of capabilityResults) {
      caseResults[result.testId] = {
        status: result.status,
        score: result.score,
        ...(result.status === 'passed' ? { lastPassedAt: result.endTime } : {}),
        ...(runModel ? { model: runModel } : {}),
      };
    }

    const baseline: EvalBaseline = {
      version: 1,
      denominatorVersion: BASELINE_DENOMINATOR_VERSION,
      plannedCaseIds: [...summary.plannedCaseIds],
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

  /**
   * mock 干跑是 harness 协议门，不是 agent 能力基线。
   * 它只能写入独立的版本化文件，且 fixture 必须全绿、所有跳过都带显式理由。
   */
  async promoteMockHarness(
    summary: TestRunSummary,
    commitSha: string,
    expectedCaseIds: string[],
  ): Promise<void> {
    if (this.kind !== 'mock-harness') {
      throw new Error('mock harness baseline 必须使用 kind=mock-harness 的独立文件');
    }
    if (summary.environment?.provider !== 'mock') {
      throw new Error('mock harness baseline 只接受 provider=mock 的运行');
    }
    const planned = new Set(summary.plannedCaseIds);
    const expected = new Set(expectedCaseIds);
    if (
      !summary.completed
      || summary.notRun > 0
      || planned.size !== expected.size
      || summary.plannedCaseIds.some((id) => !expected.has(id))
    ) {
      throw new Error('mock harness 本轮未跑满或计划题集不是评测集全集，拒绝生成 baseline');
    }

    const invalid = summary.results.filter(
      (result) => result.status !== 'passed' && result.mockExcluded === undefined,
    );
    if (invalid.length > 0) {
      throw new Error(
        `mock fixture 未全绿，拒绝生成 baseline: ${invalid.map((result) => `${result.testId}=${result.status}`).join(', ')}`,
      );
    }

    const passed = summary.results.filter((result) => result.status === 'passed');
    const excludedCases = Object.fromEntries(
      summary.results
        .filter((result) => result.mockExcluded)
        .map((result) => [result.testId, result.mockExcluded?.reason ?? '']),
    );
    const caseResults: EvalBaseline['caseResults'] = Object.fromEntries(
      passed.map((result) => [result.testId, {
        status: result.status,
        score: result.score,
        lastPassedAt: result.endTime,
        model: 'mock/mock-model',
      }]),
    );
    const averageScore = passed.length > 0
      ? passed.reduce((sum, result) => sum + result.score, 0) / passed.length
      : 0;

    await this.save({
      version: 1,
      denominatorVersion: BASELINE_DENOMINATOR_VERSION,
      plannedCaseIds: [...summary.plannedCaseIds],
      updatedAt: Date.now(),
      updatedBy: commitSha,
      mode: 'mock',
      globalMetrics: {
        passRate: passed.length > 0 ? 1 : 0,
        averageScore,
        totalCases: passed.length,
      },
      caseResults,
      excludedCases,
      thresholds: MOCK_HARNESS_THRESHOLDS,
    });
  }
}
