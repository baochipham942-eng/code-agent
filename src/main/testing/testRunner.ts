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
  TestStatus,
} from './types';
import { loadAllTestSuites, filterTestCases, sortByDependencies } from './testCaseLoader';
import { runAssertions } from './assertionEngine';
import { createLogger } from '../services/infra/logger';
import { getTestDirs } from '../config';

const execAsync = promisify(exec);
const logger = createLogger('TestRunner');

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
  /** Get current generation info */
  getGenerationInfo(): { name: string; model: string; provider: string };
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

      // Run the test
      const result = await this.runSingleTest(testCase);
      results.push(result);

      if (result.status === 'passed') {
        passedTests.add(testCase.id);
      }

      // Stop on first failure if configured
      if (this.config.stopOnFailure && result.status === 'failed') {
        logger.info('Stopping on first failure');
        break;
      }
    }

    // Build summary
    const endTime = Date.now();
    const genInfo = this.agent.getGenerationInfo();

    const summary: TestRunSummary = {
      runId,
      startTime,
      endTime,
      duration: endTime - startTime,
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
      environment: {
        generation: genInfo.name,
        model: genInfo.model,
        provider: genInfo.provider,
        workingDirectory: this.config.workingDirectory,
      },
      performance: this.calculatePerformanceStats(results),
    };

    this.emit({ type: 'suite_end', summary });

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

      // Send the test prompt
      const agentPromise = this.agent.sendMessage(testCase.prompt);
      const agentResult = await Promise.race([agentPromise, timeoutPromise]);

      result.responses = agentResult.responses;
      result.toolExecutions = agentResult.toolExecutions;
      result.turnCount = agentResult.turnCount;
      result.errors = agentResult.errors;

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

      if (assertionResult.passed) {
        result.status = 'passed';
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
    } catch (error: any) {
      result.status = 'failed';
      result.failureReason = error.message || 'Unknown error';
      result.errors.push(error.message || String(error));
      this.emit({ type: 'error', testId: testCase.id, error: error.message });
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
      } catch (error: any) {
        logger.warn(`${phase} command failed`, { cmd, error: error.message });
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
