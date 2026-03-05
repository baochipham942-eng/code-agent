// ============================================================================
// Statistical Runner - Run test cases multiple times for reliability metrics
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { TestRunner } from './testRunner';
import type { AgentInterface } from './testRunner';
import type {
  TestCase,
  TestResult,
  TestRunnerConfig,
  StatisticalConfig,
  StatisticalCaseResult,
  StatisticalRunSummary,
} from './types';
import { loadAllTestSuites, filterTestCases, sortByDependencies } from './testCaseLoader';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('StatisticalRunner');

/**
 * Default statistical configuration
 */
const DEFAULT_STATISTICAL_CONFIG: StatisticalConfig = {
  runs: 3,
  concurrency: 1,
  flakyThreshold: 0.3,
};

/**
 * Compute standard deviation from an array of numbers
 */
function stddev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Compute median from an array of numbers
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Statistical Runner - wraps TestRunner to run each case N times
 * and compute reliability metrics (pass@1, pass@k, pass^k, flakiness).
 */
export class StatisticalRunner {
  private runnerConfig: TestRunnerConfig;
  private agent: AgentInterface;
  private statConfig: StatisticalConfig;

  constructor(
    runnerConfig: TestRunnerConfig,
    agent: AgentInterface,
    statConfig?: Partial<StatisticalConfig>
  ) {
    this.runnerConfig = runnerConfig;
    this.agent = agent;
    this.statConfig = { ...DEFAULT_STATISTICAL_CONFIG, ...statConfig };
  }

  /**
   * Run all test cases multiple times and compute statistics
   */
  async runAll(): Promise<StatisticalRunSummary> {
    const runId = uuidv4();
    const startTime = Date.now();
    const { runs } = this.statConfig;

    logger.info('Starting statistical run', {
      runId,
      runs,
      concurrency: this.statConfig.concurrency,
    });

    // Load and filter test cases (same logic as TestRunner)
    const suites = await loadAllTestSuites(this.runnerConfig.testCaseDir);
    const testCases = filterTestCases(suites, {
      filterTags: this.runnerConfig.filterTags,
      filterIds: this.runnerConfig.filterIds,
    });
    const sortedCases = sortByDependencies(testCases);

    logger.info('Loaded test cases for statistical evaluation', {
      count: sortedCases.length,
    });

    // Run each case N times and collect results
    const caseResults: StatisticalCaseResult[] = [];

    for (const testCase of sortedCases) {
      if (testCase.skip) {
        continue;
      }

      const caseResult = await this.runCaseMultipleTimes(testCase, runs);
      caseResults.push(caseResult);
    }

    // Compute aggregate stats
    const endTime = Date.now();
    const aggregate = this.computeAggregate(caseResults);

    const summary: StatisticalRunSummary = {
      runId,
      config: this.statConfig,
      startTime,
      endTime,
      duration: endTime - startTime,
      caseResults,
      aggregate,
    };

    logger.info('Statistical run complete', {
      runId,
      totalCases: aggregate.totalCases,
      totalRuns: aggregate.totalRuns,
      overallPassAt1: aggregate.overallPassAt1.toFixed(3),
      flakyCases: aggregate.flakyCases.length,
    });

    return summary;
  }

  /**
   * Run a single test case N times
   */
  private async runCaseMultipleTimes(
    testCase: TestCase,
    n: number
  ): Promise<StatisticalCaseResult> {
    const runner = new TestRunner(this.runnerConfig, this.agent);
    const results: TestResult[] = [];

    logger.info(`Running case ${testCase.id} x${n}`);

    for (let i = 0; i < n; i++) {
      logger.info(`  Run ${i + 1}/${n} for ${testCase.id}`);
      const result = await runner.runSingleTest(testCase);
      results.push(result);
    }

    return this.computeCaseStats(testCase, results);
  }

  /**
   * Compute statistics for a single case across multiple runs
   */
  private computeCaseStats(
    testCase: TestCase,
    runs: TestResult[]
  ): StatisticalCaseResult {
    const k = runs.length;
    const scores = runs.map((r) => r.score);
    const durations = runs.map((r) => r.duration);

    // Status distribution
    const statusDistribution = {
      passed: runs.filter((r) => r.status === 'passed').length,
      failed: runs.filter((r) => r.status === 'failed').length,
      partial: runs.filter((r) => r.status === 'partial').length,
      skipped: runs.filter((r) => r.status === 'skipped').length,
    };

    // Pass rate (score === 1.0 counts as pass)
    const passRate = statusDistribution.passed / k;

    // pass@1: single-try reliability (same as passRate)
    const passAt1 = passRate;

    // pass@k: probability of at least 1 pass in k runs = 1 - (1 - passRate)^k
    const passAtK = 1 - Math.pow(1 - passRate, k);

    // pass^k: probability of all k runs passing = passRate^k
    const passCaretK = Math.pow(passRate, k);

    // Score statistics
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const scoreStddev = stddev(scores);

    // Flaky detection: has both passes and failures, or high score stddev
    const isFlaky =
      statusDistribution.passed > 0 &&
      statusDistribution.passed < k &&
      scoreStddev > this.statConfig.flakyThreshold;

    return {
      testId: testCase.id,
      description: testCase.description,
      totalRuns: k,
      runs,
      scoreStats: {
        mean: meanScore,
        stddev: scoreStddev,
        min: Math.min(...scores),
        max: Math.max(...scores),
        median: median(scores),
      },
      statusDistribution,
      passAt1,
      passAtK,
      passCaretK,
      isFlaky,
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      durationStddev: stddev(durations),
    };
  }

  /**
   * Compute aggregate statistics across all cases
   */
  private computeAggregate(
    caseResults: StatisticalCaseResult[]
  ): StatisticalRunSummary['aggregate'] {
    const totalCases = caseResults.length;
    const totalRuns = caseResults.reduce((sum, cr) => sum + cr.totalRuns, 0);

    const allPassAt1 = caseResults.map((cr) => cr.passAt1);
    const allPassAtK = caseResults.map((cr) => cr.passAtK);
    const allPassCaretK = caseResults.map((cr) => cr.passCaretK);
    const allMeanScores = caseResults.map((cr) => cr.scoreStats.mean);

    const overallPassAt1 =
      totalCases > 0
        ? allPassAt1.reduce((a, b) => a + b, 0) / totalCases
        : 0;
    const overallPassAtK =
      totalCases > 0
        ? allPassAtK.reduce((a, b) => a + b, 0) / totalCases
        : 0;
    const overallPassCaretK =
      totalCases > 0
        ? allPassCaretK.reduce((a, b) => a + b, 0) / totalCases
        : 0;
    const meanScore =
      totalCases > 0
        ? allMeanScores.reduce((a, b) => a + b, 0) / totalCases
        : 0;

    const flakyCases = caseResults
      .filter((cr) => cr.isFlaky)
      .map((cr) => cr.testId);
    const stableCases = caseResults
      .filter((cr) => !cr.isFlaky && cr.passAt1 === 1)
      .map((cr) => cr.testId);

    return {
      totalCases,
      totalRuns,
      overallPassAt1,
      overallPassAtK,
      overallPassCaretK,
      meanScore,
      scoreStddev: stddev(allMeanScores),
      flakyCases,
      stableCases,
    };
  }
}
