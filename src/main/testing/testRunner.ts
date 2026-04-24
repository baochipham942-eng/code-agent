// ============================================================================
// Test Runner - Execute test cases against the agent
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

import type {
  TestCase,
  TestResult,
  TestRunSummary,
  TestRunnerConfig,
  ToolExecutionRecord,
  TestEvent,
  TestEventListener,
} from './types';
import { loadAllTestSuites, filterTestCases, sortByDependencies } from './testCaseLoader';
import { runAssertions, runExpectations } from './assertionEngine';
import { execSync } from 'child_process';
import { createLogger } from '../services/infra/logger';
import { isNonRetryableError } from '../model/providers/retryStrategy';
import { getTestDirs } from '../config';
// TrajectoryBuilder loaded dynamically — excluded from production bundle
import { EvalCritic } from './evalCritic';
import { loadAllTestSuites as loadSuitesForCritic } from './testCaseLoader';

const execAsync = promisify(exec);
const logger = createLogger('TestRunner');

/** Cases with stdDev above this threshold are marked unstable */
const UNSTABLE_STDDEV_THRESHOLD = 0.2;

/**
 * Interface for agent interaction
 * This abstracts away the actual agent implementation
 */
export interface AgentInterface {
  /** Send a message to the agent and get response */
  sendMessage(prompt: string): Promise<{
    responses: string[];
    toolExecutions: ToolExecutionRecord[];
    turnCount: number;
    errors: string[];
  }>;
  /** Reset the agent state for a new test */
  reset(): Promise<void>;
  /** Get current agent info */
  getAgentInfo(): { name: string; model: string; provider: string };
  /** Get the current session ID (optional) */
  getSessionId?(): string | undefined;
}

/**
 * Test Runner - Executes test cases and collects results
 */
export class TestRunner {
  private config: TestRunnerConfig;
  private agent: AgentInterface;
  private listeners: TestEventListener[] = [];
  private aborted = false;

  constructor(config: TestRunnerConfig, agent: AgentInterface) {
    this.config = config;
    this.agent = agent;
  }

  /**
   * Add event listener
   */
  addEventListener(listener: TestEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: TestEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: TestEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('Event listener error', { error });
      }
    }
  }

  /**
   * Abort the test run
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Run all tests
   */
  async runAll(): Promise<TestRunSummary> {
    const runId = uuidv4();
    const startTime = Date.now();
    const results: TestResult[] = [];
    this.aborted = false;

    // Load test suites
    const suites = await loadAllTestSuites(this.config.testCaseDir);
    const testCases = filterTestCases(suites, {
      filterTags: this.config.filterTags,
      filterIds: this.config.filterIds,
    });
    const sortedCases = sortByDependencies(testCases);

    logger.info('Starting test run', {
      runId,
      totalCases: sortedCases.length,
      suites: suites.map((s) => s.name),
    });

    this.emit({
      type: 'suite_start',
      suite: 'all',
      totalCases: sortedCases.length,
    });

    // Track passed tests for dependency checking
    const passedTests = new Set<string>();

    const trialsPerCase = this.config.trialsPerCase ?? 1;

    // Run each test case
    for (const testCase of sortedCases) {
      if (this.aborted) {
        logger.info('Test run aborted');
        break;
      }

      // Check dependencies
      if (testCase.depends_on && testCase.depends_on.length > 0) {
        const unmetDeps = testCase.depends_on.filter((dep) => !passedTests.has(dep));
        if (unmetDeps.length > 0) {
          const result = this.createSkippedResult(
            testCase,
            `Dependencies not met: ${unmetDeps.join(', ')}`
          );
          results.push(result);
          this.emit({ type: 'case_end', result });
          continue;
        }
      }

      if (trialsPerCase <= 1) {
        // Single trial (default behavior)
        const result = await this.runSingleTest(testCase);
        results.push(result);

        if (result.status === 'passed' || result.status === 'partial') {
          passedTests.add(testCase.id);
        }
      } else {
        // Multiple trials: run each case trialsPerCase times, take best score (pass@k)
        const trialResults: Array<{ score: number; status: TestResult['status']; duration_ms: number }> = [];
        let bestResult: TestResult | null = null;

        for (let trial = 0; trial < trialsPerCase; trial++) {
          if (this.aborted) break;
          logger.info(`Running trial ${trial + 1}/${trialsPerCase} for case ${testCase.id}`);
          const result = await this.runSingleTest(testCase);
          trialResults.push({ score: result.score, status: result.status, duration_ms: result.duration });

          if (!bestResult || result.score > bestResult.score) {
            bestResult = result;
          }
        }

        if (bestResult) {
          // Attach trial data to best result
          bestResult.trials = trialResults;

          // Compute variance and stdDev of trial scores
          const scores = trialResults.map(t => t.score);
          const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
          const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
          const stdDev = Math.sqrt(variance);
          bestResult.variance = variance;
          bestResult.stdDev = stdDev;
          bestResult.unstable = stdDev > UNSTABLE_STDDEV_THRESHOLD;

          results.push(bestResult);

          if (bestResult.status === 'passed' || bestResult.status === 'partial') {
            passedTests.add(testCase.id);
          }
        }
      }

      // Stop on first failure if configured
      const lastResult = results[results.length - 1];
      if (this.config.stopOnFailure && lastResult?.status === 'failed') {
        logger.info('Stopping on first failure');
        break;
      }
    }

    // Build summary
    const endTime = Date.now();
    const genInfo = this.agent.getAgentInfo();

    const nonSkipped = results.filter((r) => r.status !== 'skipped');
    const avgScore = nonSkipped.length > 0
      ? nonSkipped.reduce((sum, r) => sum + r.score, 0) / nonSkipped.length
      : 0;

    // Compute stability metrics for cases with trials
    const casesWithTrials = results.filter(r => r.stdDev !== undefined);
    const unstableCaseCount = casesWithTrials.filter(r => r.unstable).length;
    const averageStdDev = casesWithTrials.length > 0
      ? casesWithTrials.reduce((sum, r) => sum + (r.stdDev ?? 0), 0) / casesWithTrials.length
      : undefined;

    const summary: TestRunSummary = {
      runId,
      startTime,
      endTime,
      duration: endTime - startTime,
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      partial: results.filter((r) => r.status === 'partial').length,
      averageScore: avgScore,
      results,
      environment: {
        generation: genInfo.name,
        model: genInfo.model,
        provider: genInfo.provider,
        workingDirectory: this.config.workingDirectory,
      },
      performance: this.calculatePerformanceStats(results),
      gitCommit: (() => { try { return execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return 'unknown'; } })(),
      ...(casesWithTrials.length > 0 ? { unstableCaseCount, averageStdDev } : {}),
    };

    this.emit({ type: 'suite_end', summary });

    // P4: Eval self-evolution critic (when enabled)
    if (this.config.enableEvalCritic !== false) {
      try {
        const critic = new EvalCritic({ enableLLM: this.config.evalCriticUseLLM });
        const allSuites = await loadSuitesForCritic(this.config.testCaseDir);
        const allCases = allSuites.flatMap((s) => s.cases);
        summary.evalFeedback = await critic.critique(summary, allCases);
      } catch (criticError: unknown) {
        const message = criticError instanceof Error ? criticError.message : String(criticError);
        logger.warn('Eval critic failed', { error: message });
      }
    }

    // Save results
    await this.saveResults(summary);

    return summary;
  }

  /**
   * Run a single test case
   */
  async runSingleTest(testCase: TestCase): Promise<TestResult> {
    const startTime = Date.now();
    const result: TestResult = {
      testId: testCase.id,
      description: testCase.description,
      status: 'running',
      duration: 0,
      startTime,
      endTime: 0,
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 0,
      score: 0,
    };

    logger.info('Running test', { testId: testCase.id });
    this.emit({ type: 'case_start', testId: testCase.id, description: testCase.description });

    try {
      // Run setup commands
      if (testCase.setup && testCase.setup.length > 0) {
        await this.runCommands(testCase.setup, 'setup');
      }

      // Reset agent state
      await this.agent.reset();

      // Set up timeout
      const timeout = testCase.timeout || this.config.defaultTimeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Test timeout after ${timeout}ms`)), timeout);
      });

      // Send the test prompt (and follow-up prompts for multi-turn)
      const agentPromise = this.agent.sendMessage(testCase.prompt);
      const agentResult = await Promise.race([agentPromise, timeoutPromise]);

      result.responses = agentResult.responses;
      result.toolExecutions = agentResult.toolExecutions;
      result.turnCount = agentResult.turnCount;
      result.errors = agentResult.errors;
      result.sessionId = this.agent.getSessionId?.();

      // Multi-turn: send follow-up prompts sequentially
      if (testCase.follow_up_prompts && testCase.follow_up_prompts.length > 0) {
        for (const followUp of testCase.follow_up_prompts) {
          const remainingTime = timeout - (Date.now() - startTime);
          if (remainingTime <= 0) break;

          const followUpTimeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Follow-up timeout after ${timeout}ms`)), remainingTime);
          });
          const followUpResult = await Promise.race([
            this.agent.sendMessage(followUp),
            followUpTimeout,
          ]);

          result.responses.push(...followUpResult.responses);
          result.toolExecutions.push(...followUpResult.toolExecutions);
          result.turnCount += followUpResult.turnCount;
          result.errors.push(...followUpResult.errors);
        }
      }

      // Emit tool events
      for (const te of result.toolExecutions) {
        this.emit({
          type: 'tool_result',
          testId: testCase.id,
          tool: te.tool,
          success: te.success,
        });
      }

      // Run assertions
      const assertionResult = await runAssertions(testCase.expect, {
        toolExecutions: result.toolExecutions,
        responses: result.responses,
        errors: result.errors,
        turnCount: result.turnCount,
        workingDirectory: this.config.workingDirectory,
      });

      result.score = assertionResult.score;
      result.reference_solution = testCase.reference_solution;

      if (assertionResult.score === 1.0) {
        result.status = 'passed';
      } else if (assertionResult.score > 0) {
        result.status = 'partial';
        result.failureReason = assertionResult.failures
          .map((f) => f.message)
          .join('; ');
        result.failureDetails = {
          expected: assertionResult.failures.map((f) => f.expected),
          actual: assertionResult.failures.map((f) => f.actual),
          assertion: assertionResult.failures.map((f) => f.assertion).join(', '),
        };
      } else {
        result.status = 'failed';
        result.failureReason = assertionResult.failures
          .map((f) => f.message)
          .join('; ');
        result.failureDetails = {
          expected: assertionResult.failures.map((f) => f.expected),
          actual: assertionResult.failures.map((f) => f.actual),
          assertion: assertionResult.failures.map((f) => f.assertion).join(', '),
        };
      }

      // P1: Expectation-based assertions (when available, override legacy assertions)
      if (testCase.expectations && testCase.expectations.length > 0) {
        const expResult = await runExpectations(testCase.expectations, {
          toolExecutions: result.toolExecutions,
          responses: result.responses,
          errors: result.errors,
          turnCount: result.turnCount,
          workingDirectory: this.config.workingDirectory,
        });
        result.expectationResults = expResult.results;
        result.score = expResult.overallScore;
        if (expResult.passed) {
          result.status = 'passed';
          result.failureReason = undefined;
          result.failureDetails = undefined;
        } else if (expResult.overallScore > 0 && !expResult.hasCriticalFailure) {
          result.status = 'partial';
          result.failureReason = expResult.results
            .filter((r) => !r.passed)
            .map((r) => `[${r.expectation.type}] ${r.evidence.details ?? 'failed'}`)
            .join('; ');
        } else {
          result.status = 'failed';
          result.failureReason = expResult.results
            .filter((r) => !r.passed)
            .map((r) => `[${r.expectation.type}] ${r.evidence.details ?? 'failed'}`)
            .join('; ');
        }
      }

      // P3: Trajectory analysis (when enabled)
      if (this.config.enableTrajectoryAnalysis) {
        try {
          const { TrajectoryBuilder } = await import('../evaluation/trajectory');
          const builder = new TrajectoryBuilder();
          result.trajectory = builder.buildFromTestResult(result, testCase);
        } catch (trajError: unknown) {
          const message = trajError instanceof Error ? trajError.message : String(trajError);
          logger.warn('Trajectory analysis failed', { testId: testCase.id, error: message });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      result.failureReason = message || 'Unknown error';
      result.errors.push(message || String(error));
      this.emit({ type: 'error', testId: testCase.id, error: message });
      // Circuit breaker: 账号/余额/内容策略等持久性错误 → abort 整个 run，
      // 避免后续 case 重复踩同一个错误烧 API 费。
      if (isNonRetryableError(message)) {
        logger.error('Fatal inference error — aborting run', { testId: testCase.id, error: message });
        this.aborted = true;
      }
    } finally {
      // Run cleanup commands
      if (testCase.cleanup && testCase.cleanup.length > 0) {
        try {
          await this.runCommands(testCase.cleanup, 'cleanup');
        } catch (error) {
          logger.warn('Cleanup failed', { testId: testCase.id, error });
        }
      }

      result.endTime = Date.now();
      result.duration = result.endTime - result.startTime;

      logger.info('Test completed', {
        testId: testCase.id,
        status: result.status,
        duration: result.duration,
      });

      this.emit({ type: 'case_end', result });
    }

    return result;
  }

  /**
   * Run shell commands (setup/cleanup)
   */
  private async runCommands(commands: string[], phase: string): Promise<void> {
    for (const cmd of commands) {
      try {
        await execAsync(cmd, { cwd: this.config.workingDirectory });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`${phase} command failed`, { cmd, error: message });
        throw new Error(`${phase} failed: ${cmd}`);
      }
    }
  }

  /**
   * Create a skipped result
   */
  private createSkippedResult(testCase: TestCase, reason: string): TestResult {
    const now = Date.now();
    return {
      testId: testCase.id,
      description: testCase.description,
      status: 'skipped',
      duration: 0,
      startTime: now,
      endTime: now,
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 0,
      score: 0,
      failureReason: reason,
    };
  }

  /**
   * Calculate performance statistics
   */
  private calculatePerformanceStats(
    results: TestResult[]
  ): TestRunSummary['performance'] {
    const durations = results.filter((r) => r.status !== 'skipped').map((r) => r.duration);

    return {
      avgResponseTime: durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0,
      maxResponseTime: durations.length > 0 ? Math.max(...durations) : 0,
      totalToolCalls: results.reduce((sum, r) => sum + r.toolExecutions.length, 0),
      totalTurns: results.reduce((sum, r) => sum + r.turnCount, 0),
    };
  }

  /**
   * Save results to file
   */
  private async saveResults(summary: TestRunSummary): Promise<void> {
    const resultsDir = this.config.resultsDir;
    await fs.mkdir(resultsDir, { recursive: true });

    // Save JSON results
    const jsonPath = path.join(
      resultsDir,
      `test-results-${new Date().toISOString().slice(0, 10)}.json`
    );
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));

    logger.info('Results saved', { path: jsonPath });

    // Persist to unified experiment DB (best-effort)
    try {
      const { ExperimentAdapter } = await import('../evaluation/experimentAdapter');
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      const adapter = new ExperimentAdapter(db);
      await adapter.persistTestRun(summary);
      logger.info('Test run persisted to experiment DB');
    } catch (err) {
      // DB persistence is best-effort, don't fail the test run
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to persist test run to DB', { error: msg });
      summary.persistenceWarning = `DB persistence failed: ${msg}`;
    }
  }
}

/**
 * Create default test runner configuration
 * Note: Uses new .code-agent/ paths by default. Callers can override with legacy paths if needed.
 */
export function createDefaultConfig(
  workingDirectory: string,
  overrides: Partial<TestRunnerConfig> = {}
): TestRunnerConfig {
  const testDirs = getTestDirs(workingDirectory);
  return {
    testCaseDir: testDirs.testCases.new, // Default to new path
    resultsDir: testDirs.results.new,
    workingDirectory,
    defaultTimeout: 60000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    ...overrides,
  };
}
