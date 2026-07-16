// ============================================================================
// Test Runner - Execute test cases against the agent
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
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
  UserSimulation,
  EvalGoalContract,
  GoalRunRecord,
} from './types';
import { loadAllTestSuites, filterTestCases, sortByDependencies } from './testCaseLoader';
import { validateUserSimulation, evaluateSimRules, DEFAULT_SIM_MAX_TURNS } from './userSimulator';
import { validateGoalContract } from './goalContractEval';
import { withTimeout } from '../services/infra/timeoutController';
import { runAssertions, runExpectations, countDeclaredAssertions } from './assertionEngine';
import { execSync } from 'child_process';
import { createLogger } from '../services/infra/logger';
import { isNonRetryableError, isTransientError } from '../model/providers/retryStrategy';
import { getTestDirs } from '../config';
import { buildSessionTraceIdentity } from '../../shared/contract/reviewQueue';
import type { StructuredReplay } from '../../shared/contract/evaluation';
import { evaluateAgentTrajectoryReplay } from '../evaluation/trajectory/trajectoryGate';
// TrajectoryBuilder loaded dynamically — excluded from production bundle
import { EvalCritic } from './evalCritic';
import { loadAllTestSuites as loadSuitesForCritic } from './testCaseLoader';
import { isProviderVariantDisabled } from '../prompts/providerVariants';
import { OS_SANDBOX } from '../../shared/constants/sandbox';
import { getSandboxManager } from '../sandbox';

const execAsync = promisify(exec);
const logger = createLogger('TestRunner');

/** Cases with stdDev above this threshold are marked unstable */
const UNSTABLE_STDDEV_THRESHOLD = 0.2;

/**
 * 红线/破坏性 case 判定（ADR-036 F3）：category=security 或 tags 含 redline/security。
 * category 在 YAML 里是自由字符串（loader 不校验枚举），故用 string 比较。
 */
function isRedlineCase(tc: TestCase): boolean {
  const category = tc.category as string | undefined;
  const tags = tc.tags ?? [];
  return category === 'security' || tags.includes('redline') || tags.includes('security');
}

/**
 * 当前 host 是否有会真正包住 bash 执行的 OS 级 jail。
 * 对齐 bash.ts 的 shouldSandbox：OS_SANDBOX.ENABLED + 平台沙箱（bwrap/seatbelt）可用。
 */
function isOsJailActive(): boolean {
  return OS_SANDBOX.ENABLED && getSandboxManager().isAvailable();
}

/**
 * WP1-2：判定错误是否属基础设施故障（429/超时/5xx/网络）。
 * 这类失败是环境噪声不是 agent 能力信号，分流进 infra_excluded 桶，
 * 不进能力通过率分母。复用 retryStrategy 的瞬态错误词表（已排除
 * 余额/认证等致命错误——那些走 circuit breaker abort），另补 test
 * harness 自身的超时消息（withTimeout 的 "timeout after Nms"）。
 */
export function isInfraExclusionError(msg: string): boolean {
  // 'fetch failed'：Node fetch/undici 网络不可达的通用报错，不在 retryStrategy
  // 词表里（2026-07-03 断网实测：115 个 case 因此被误记 failed 混进能力分母）
  return isTransientError(msg) || /timeout after \d+ms/i.test(msg) || /fetch failed/i.test(msg);
}

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
  /** Flush/end the current telemetry session after a case completes (optional) */
  finalizeSession?(): Promise<void>;
  /**
   * 批 6：接收当前 case 的 user_simulation 配置（审批门 permission_policy 注入用）。
   * runner 每个 case 都会调用（无模拟时传 undefined 清除上个 case 的配置）。
   */
  configureUserSimulation?(sim: UserSimulation | undefined): void;
  /**
   * B6b-①：接收当前 case 的 goal 契约（case 以 /goal 自治模式跑）。
   * runner 每个 case 都会调用（无契约时传 undefined 清除上个 case 的配置）。
   */
  configureGoalContract?(contract: EvalGoalContract | undefined): void;
  /** Inject per-case sandbox policy, currently used to force redline cases offline. */
  configureSandboxPolicy?(policy: { redline: boolean } | undefined): void;
  /** B6b-①：goal run 行为落账（goal_status / goal_evidence_gate 断言的锚点数据） */
  getGoalRunRecord?(): GoalRunRecord | undefined;
}

export type AgentFactory = (context: {
  workingDirectory: string;
}) => AgentInterface | Promise<AgentInterface>;

interface WorkerDirectory {
  workingDirectory: string;
  cleanup(): void | Promise<void>;
}

export type WorkerDirectoryFactory = () => WorkerDirectory | Promise<WorkerDirectory>;

interface TestExecutionContext {
  agent: AgentInterface;
  workingDirectory: string;
}

interface ParallelWorker extends TestExecutionContext {
  cleanup(): void | Promise<void>;
}

/**
 * Test Runner - Executes test cases and collects results
 */
export class TestRunner {
  private config: TestRunnerConfig;
  private agent: AgentInterface;
  private agentFactory?: AgentFactory;
  private workerDirectoryFactory?: WorkerDirectoryFactory;
  private listeners: TestEventListener[] = [];
  private aborted = false;
  private abortReason?: string;

  constructor(
    config: TestRunnerConfig,
    agent: AgentInterface,
    agentFactory?: AgentFactory,
    workerDirectoryFactory?: WorkerDirectoryFactory,
  ) {
    this.config = config;
    this.agent = agent;
    this.agentFactory = agentFactory;
    this.workerDirectoryFactory = workerDirectoryFactory;
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

  private isRealAgentRunCase(testCase: TestCase): boolean {
    return testCase.tags?.includes('real-agent-run') ?? false;
  }

  private validateRealAgentRunReplay(replay: StructuredReplay | null): string[] {
    const gate = evaluateAgentTrajectoryReplay(replay);
    return gate.exportReady ? [] : gate.failures;
  }

  private async attachTelemetryReplay(
    testCase: TestCase,
    result: TestResult,
    agent: AgentInterface,
  ): Promise<void> {
    const requiresRealAgentRun = this.isRealAgentRunCase(testCase);
    if (result.sessionId) {
      result.replayKey = buildSessionTraceIdentity(result.sessionId).replayKey;
    }

    await agent.finalizeSession?.();

    let replay: StructuredReplay | null = null;
    if (result.sessionId) {
      try {
        const { getTelemetryQueryService } = await import('../evaluation/telemetryQueryService');
        replay = await getTelemetryQueryService().getStructuredReplay(result.sessionId);
        if (replay) {
          result.replayKey = replay.traceIdentity.replayKey;
          result.telemetryCompleteness = replay.summary.telemetryCompleteness;
        }
      } catch (error) {
        logger.warn('Failed to attach structured replay telemetry', {
          testId: testCase.id,
          sessionId: result.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!requiresRealAgentRun) return;

    const failures = this.validateRealAgentRunReplay(replay);
    result.telemetryGate = {
      name: 'real-agent-run',
      passed: failures.length === 0,
      failures,
    };

    if (failures.length === 0) return;

    const gateReason = `real-agent-run gate failed: ${failures.join(', ')}`;
    result.status = 'failed';
    result.score = 0;
    result.failureStage = 'telemetry_replay_gate';
    result.failureReason = result.failureReason
      ? `${result.failureReason}; ${gateReason}`
      : gateReason;
    result.errors.push(gateReason);
  }

  private toTrialSummary(result: TestResult): NonNullable<TestResult['trials']>[number] {
    return {
      score: result.score,
      status: result.status,
      duration_ms: result.duration,
      sessionId: result.sessionId,
      replayKey: result.replayKey,
      telemetryCompleteness: result.telemetryCompleteness,
      telemetryGate: result.telemetryGate,
      failureStage: result.failureStage,
      failureReason: result.failureReason,
      errors: result.errors.length > 0 ? [...result.errors] : undefined,
    };
  }

  /**
   * Run all tests
   */
  async runAll(): Promise<TestRunSummary> {
    const useParallelWorkers = this.config.parallel && this.config.maxParallel > 1;
    if (useParallelWorkers && !this.agentFactory) {
      throw new Error(
        'parallel execution requires agentFactory so each worker has an isolated agent instance'
      );
    }

    const runId = this.config.runId || uuidv4();
    const startTime = Date.now();
    const results: TestResult[] = [];
    this.aborted = false;
    this.abortReason = undefined;

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

    const trialsPerCase = this.config.trialsPerCase ?? 1;

    if (useParallelWorkers) {
      results.push(...await this.runParallelCases(sortedCases, trialsPerCase));
    } else {
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

      if (trialsPerCase <= 1) {
        // Single trial (default behavior)
        const result = await this.runSingleTest(testCase);
        results.push(result);

        if (result.status === 'passed' || result.status === 'partial') {
          passedTests.add(testCase.id);
        }
      } else {
        // Multiple trials: pass@k, with real-agent-run telemetry as a hard gate.
        const trialResults: NonNullable<TestResult['trials']> = [];
        let bestResult: TestResult | null = null;
        let telemetryGateFailureResult: TestResult | null = null;

        for (let trial = 0; trial < trialsPerCase; trial++) {
          if (this.aborted) break;
          logger.info(`Running trial ${trial + 1}/${trialsPerCase} for case ${testCase.id}`);
          const result = await this.runSingleTest(testCase);
          trialResults.push(this.toTrialSummary(result));

          if (this.isRealAgentRunCase(testCase) && result.telemetryGate?.passed === false) {
            telemetryGateFailureResult ??= result;
          }

          if (!bestResult || result.score > bestResult.score) {
            bestResult = result;
          }
        }

        if (bestResult) {
          if (telemetryGateFailureResult) {
            bestResult = telemetryGateFailureResult;
          }

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
    }

    // Build summary
    const endTime = Date.now();
    const genInfo = this.agent.getAgentInfo();

    // skipped 与 infra_excluded 都不进能力分母（后者是环境噪声，WP1-2）
    const nonSkipped = results.filter((r) => r.status !== 'skipped' && r.status !== 'infra_excluded');
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
      infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
      averageScore: avgScore,
      results,
      environment: {
        model: genInfo.model,
        provider: genInfo.provider,
        workingDirectory: this.config.workingDirectory,
        // roadmap 2.4 A/B 归因（audit D-R3）：记录 variant 臂，两臂结果可对比
        providerVariantArm: isProviderVariantDisabled() ? 'variant-off' : 'variant-on',
      },
      performance: this.calculatePerformanceStats(results),
      gitCommit: (() => { try { return execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return 'unknown'; } })(),
      ...(casesWithTrials.length > 0 ? { unstableCaseCount, averageStdDev } : {}),
      ...(this.aborted && this.abortReason ? { aborted: true, abortReason: this.abortReason } : {}),
      // GAP-017: harness 配置随 summary 落 DB（对照实验维度）
      ...(this.config.harness ? { harness: this.config.harness } : {}),
      // WP1-4: prompt 改动预测随 summary 落盘/DB，deltaReporter 对账
      ...(this.config.prediction ? { prediction: this.config.prediction } : {}),
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

  private async createParallelWorkers(count: number): Promise<ParallelWorker[]> {
    const workers: ParallelWorker[] = [];
    try {
      for (let index = 0; index < count; index++) {
        let directory: WorkerDirectory;
        if (this.workerDirectoryFactory) {
          directory = await this.workerDirectoryFactory();
        } else {
          const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-eval-worker-'));
          const workingDirectory = path.join(root, 'work');
          await fs.cp(this.config.workingDirectory, workingDirectory, { recursive: true });
          directory = {
            workingDirectory,
            cleanup: () => fs.rm(root, { recursive: true, force: true }),
          };
        }

        try {
          const agent = await this.agentFactory!({
            workingDirectory: directory.workingDirectory,
          });
          workers.push({
            agent,
            workingDirectory: directory.workingDirectory,
            cleanup: directory.cleanup,
          });
        } catch (error) {
          await directory.cleanup();
          throw error;
        }
      }
      return workers;
    } catch (error) {
      await Promise.allSettled(workers.map((worker) => worker.cleanup()));
      throw error;
    }
  }

  private async runParallelCases(
    sortedCases: TestCase[],
    trialsPerCase: number,
  ): Promise<TestResult[]> {
    if (sortedCases.length === 0) return [];

    const workerCount = Math.min(this.config.maxParallel, sortedCases.length);
    const workers = await this.createParallelWorkers(workerCount);
    const availableWorkers = [...workers];
    const pending = new Set(sortedCases.map((_, index) => index));
    const caseIndexes = new Map(sortedCases.map((testCase, index) => [testCase.id, index]));
    const completed = new Set<string>();
    const passed = new Set<string>();
    const resultsByIndex: Array<TestResult | undefined> = new Array(sortedCases.length);
    const running = new Map<number, Promise<{
      index: number;
      result: TestResult;
      worker: ParallelWorker;
    }>>();
    let stopScheduling = false;

    try {
      while (pending.size > 0 || running.size > 0) {
        let madeProgress = false;

        if (!stopScheduling && !this.aborted) {
          for (const index of [...pending]) {
            const testCase = sortedCases[index];
            const dependencies = testCase.depends_on ?? [];
            const dependenciesComplete = dependencies.every((dependency) =>
              !caseIndexes.has(dependency) || completed.has(dependency)
            );
            if (!dependenciesComplete) continue;

            const unmetDependencies = dependencies.filter((dependency) => !passed.has(dependency));
            if (unmetDependencies.length > 0) {
              const result = this.createSkippedResult(
                testCase,
                `Dependencies not met: ${unmetDependencies.join(', ')}`,
              );
              pending.delete(index);
              resultsByIndex[index] = result;
              completed.add(testCase.id);
              this.emit({ type: 'case_end', result });
              madeProgress = true;
              continue;
            }

            const worker = availableWorkers.shift();
            if (!worker) break;

            pending.delete(index);
            const task = this.runParallelCaseTrials(testCase, trialsPerCase, worker)
              .then((result) => ({ index, result, worker }));
            running.set(index, task);
            madeProgress = true;
          }
        }

        if (running.size > 0) {
          const completedTask = await Promise.race(running.values());
          running.delete(completedTask.index);
          availableWorkers.push(completedTask.worker);
          resultsByIndex[completedTask.index] = completedTask.result;
          const completedCase = sortedCases[completedTask.index];
          completed.add(completedCase.id);
          if (
            completedTask.result.status === 'passed'
            || completedTask.result.status === 'partial'
          ) {
            passed.add(completedCase.id);
          }
          if (this.config.stopOnFailure && completedTask.result.status === 'failed') {
            logger.info('Stopping on first failure');
            stopScheduling = true;
          }
          continue;
        }

        if (this.aborted || stopScheduling) break;
        if (!madeProgress && pending.size > 0) {
          throw new Error('Parallel dependency scheduler made no progress');
        }
      }
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.cleanup()));
    }

    return resultsByIndex.filter((result): result is TestResult => result !== undefined);
  }

  private async runParallelCaseTrials(
    testCase: TestCase,
    trialsPerCase: number,
    context: TestExecutionContext,
  ): Promise<TestResult> {
    if (trialsPerCase <= 1) {
      return this.runSingleTest(testCase, context);
    }

    const trialResults: NonNullable<TestResult['trials']> = [];
    let bestResult: TestResult | null = null;
    let telemetryGateFailureResult: TestResult | null = null;

    for (let trial = 0; trial < trialsPerCase; trial++) {
      if (this.aborted) break;
      logger.info(`Running trial ${trial + 1}/${trialsPerCase} for case ${testCase.id}`);
      const result = await this.runSingleTest(testCase, context);
      trialResults.push(this.toTrialSummary(result));

      if (this.isRealAgentRunCase(testCase) && result.telemetryGate?.passed === false) {
        telemetryGateFailureResult ??= result;
      }
      if (!bestResult || result.score > bestResult.score) {
        bestResult = result;
      }
    }

    if (!bestResult) {
      return this.createSkippedResult(testCase, 'Test run aborted before trial execution');
    }
    if (telemetryGateFailureResult) {
      bestResult = telemetryGateFailureResult;
    }

    bestResult.trials = trialResults;
    const scores = trialResults.map((trial) => trial.score);
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    bestResult.variance = variance;
    bestResult.stdDev = stdDev;
    bestResult.unstable = stdDev > UNSTABLE_STDDEV_THRESHOLD;
    return bestResult;
  }

  /**
   * Run a single test case
   */
  async runSingleTest(
    testCase: TestCase,
    context: TestExecutionContext = {
      agent: this.agent,
      workingDirectory: this.config.workingDirectory,
    },
  ): Promise<TestResult> {
    const { agent, workingDirectory } = context;
    const startTime = Date.now();
    const result: TestResult = {
      testId: testCase.id,
      description: testCase.description,
      prompt: testCase.prompt,
      followUpPrompts: testCase.follow_up_prompts,
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

    // 附件注入产物路径（finally 里清理，避免污染同沙箱后续 case）
    const injectedFiles: string[] = [];

    try {
      // F3 红线闸（ADR-036）：破坏性/红线 case 期望模型"拒绝"，但顺从模型会真执行
      // 破坏性命令（错题本 2026-07-04：LongCat 真删 15 个项目 node_modules）。护栏
      // 必须是机制不是断言——无可用 OS jail 时直接 infra_excluded，绝不裸跑。
      if (isRedlineCase(testCase) && !isOsJailActive()) {
        result.status = 'infra_excluded';
        result.failureStage = 'infra';
        result.failureReason =
          '红线/破坏性 case 需 OS 级 jail 才能安全执行；当前 host 无可用 jail'
          + '（未设 OS_SANDBOX_ENABLED 或平台沙箱不可用），已跳过以防真实执行破坏性命令。';
        return result;
      }

      // 批 6 fail-loud：user_simulation 配置错误在花任何 agent 调用之前显式失败，
      // 绝不静默降级成单轮跑（那会把"模拟没生效"伪装成能力数据）。
      if (testCase.user_simulation) {
        const configError = testCase.follow_up_prompts && testCase.follow_up_prompts.length > 0
          ? 'user_simulation cannot be combined with follow_up_prompts (ambiguous multi-turn semantics)'
          : validateUserSimulation(testCase.user_simulation);
        if (configError) {
          result.status = 'failed';
          result.failureReason = configError;
          result.errors.push(configError);
          this.emit({ type: 'error', testId: testCase.id, error: configError });
          return result;
        }
        result.simTurns = [];
      }

      // B6b-① fail-loud：goal_contract 配置错误（无完成判据 / 与 user_simulation·
      // follow_up_prompts 互斥）同样在花任何 agent 调用之前显式失败。
      if (testCase.goal_contract) {
        const goalConfigError = validateGoalContract(testCase);
        if (goalConfigError) {
          result.status = 'failed';
          result.failureReason = goalConfigError;
          result.errors.push(goalConfigError);
          this.emit({ type: 'error', testId: testCase.id, error: goalConfigError });
          return result;
        }
      }

      // Run setup commands
      if (testCase.setup && testCase.setup.length > 0) {
        await this.runCommands(testCase.setup, 'setup', workingDirectory);
      }

      // GAIA 等外部基准的附件：跑前拷进工作目录（缺失/越界都 fail loud）
      if (testCase.files && testCase.files.length > 0) {
        injectedFiles.push(...await this.injectCaseFiles(testCase.files, workingDirectory));
      }

      // Reset agent state
      await agent.reset();

      agent.configureSandboxPolicy?.({ redline: isRedlineCase(testCase) });

      // 批 6：审批门策略注入（无模拟的 case 传 undefined，清掉上个 case 的配置）
      agent.configureUserSimulation?.(testCase.user_simulation);

      // B6b-①：goal 契约注入（无契约的 case 传 undefined，清掉上个 case 的配置）
      agent.configureGoalContract?.(testCase.goal_contract);

      // Set up timeout — CODE_AGENT_FORCE_TIMEOUT overrides per-case timeout (for slow local models)
      const forceTimeout = process.env.CODE_AGENT_FORCE_TIMEOUT
        ? parseInt(process.env.CODE_AGENT_FORCE_TIMEOUT, 10)
        : null;
      const baseTimeout = forceTimeout || testCase.timeout || this.config.defaultTimeout;
      // CODE_AGENT_TIMEOUT_SCALE: 慢模型(如 mimo，单 case 13-300s)整体放宽 per-case timeout，
      // 同时保留 case 间相对预算（3s 的中止测试与 300s 的 artifact 仍按比例区分），
      // 避免 FORCE_TIMEOUT 把所有 case 压成同一绝对值。默认 1，快模型不受影响。
      // forceTimeout 是显式绝对覆盖，不再叠加 scale。
      const scaleRaw = parseFloat(process.env.CODE_AGENT_TIMEOUT_SCALE || '1');
      const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1;
      const timeout = forceTimeout ? baseTimeout : Math.round(baseTimeout * scale);

      // Send the test prompt (withTimeout 自动清理 timer)
      const agentResult = await withTimeout(
        agent.sendMessage(testCase.prompt),
        timeout,
        `Test timeout after ${timeout}ms`,
      );

      result.responses = agentResult.responses;
      result.toolExecutions = agentResult.toolExecutions;
      result.turnCount = agentResult.turnCount;
      result.errors = agentResult.errors;
      result.sessionId = agent.getSessionId?.();

      // B6b-①：goal run 行为落账必须在断言求值之前就位（runAssertions/runExpectations
      // 都在本 try 内），否则 goal_status/goal_evidence_gate 会 fail-loud 把真达成判红。
      // 超时/异常路径的兜底捕获见 finally（审计 R1-M2）。
      if (testCase.goal_contract) {
        result.goalRun = agent.getGoalRunRecord?.();
      }

      // 批 6：条件应答多轮（follow_up_prompts 的升级形态，两者互斥已在入口校验）。
      // 每轮只对 agent 上一轮的输出求值；命中 respond 则把脚本文本作为下一轮
      // user 输入，命中 stop（或无规则命中/轮数用尽）即终止 —— 模拟用户离场。
      if (testCase.user_simulation) {
        const sim = testCase.user_simulation;
        const maxSimTurns = sim.max_turns ?? DEFAULT_SIM_MAX_TURNS;
        const matchCounts = new Map<string, number>();
        let lastTurn = {
          responses: agentResult.responses,
          toolExecutions: agentResult.toolExecutions,
        };
        for (let simTurn = 0; simTurn < maxSimTurns; simTurn++) {
          const match = evaluateSimRules(sim, lastTurn, matchCounts);
          if (!match) break;
          result.simTurns?.push({
            ruleId: match.rule.id,
            action: match.action,
            message: match.message,
            toolExecutionsBefore: result.toolExecutions.length,
            responsesBefore: result.responses.length,
          });
          if (match.action === 'stop') break;

          const remainingTime = timeout - (Date.now() - startTime);
          if (remainingTime <= 0) {
            // 审计 R1-H2：规则要求应答但预算耗尽 —— 静默 break 会让
            // sim_stop_respected 在"拒绝从未送达"时假绿。显式抛超时，
            // 与首轮/follow-up 的 withTimeout 同款消息格式 → 外层 catch
            // 按存量口径分流 infra_excluded（时间预算问题不是能力数据）。
            throw new Error(`Test timeout after ${timeout}ms (budget exhausted before simulated user turn)`);
          }
          const simResult = await withTimeout(
            agent.sendMessage(match.message!),
            remainingTime,
            `Simulated user turn timeout after ${timeout}ms`,
          );
          result.responses.push(...simResult.responses);
          result.toolExecutions.push(...simResult.toolExecutions);
          result.turnCount += simResult.turnCount;
          result.errors.push(...simResult.errors);
          lastTurn = {
            responses: simResult.responses,
            toolExecutions: simResult.toolExecutions,
          };

          if (match.rule.stop) {
            // respond+stop（拒绝分支）：发完拒绝文本、收完 agent 的应答后离场。
            // 该 stop 记录的快照即"拒绝之后"边界，sim_stop_respected 以 respond
            // 记录为锚点检查其后的工具调用。
            result.simTurns?.push({
              ruleId: match.rule.id,
              action: 'stop',
              toolExecutionsBefore: result.toolExecutions.length,
              responsesBefore: result.responses.length,
            });
            break;
          }
        }
      }

      // Multi-turn: send follow-up prompts sequentially
      if (testCase.follow_up_prompts && testCase.follow_up_prompts.length > 0) {
        for (const followUp of testCase.follow_up_prompts) {
          const remainingTime = timeout - (Date.now() - startTime);
          if (remainingTime <= 0) break;

          const followUpResult = await withTimeout(
            agent.sendMessage(followUp),
            remainingTime,
            `Follow-up timeout after ${timeout}ms`,
          );

          result.responses.push(...followUpResult.responses);
          result.toolExecutions.push(...followUpResult.toolExecutions);
          result.turnCount += followUpResult.turnCount;
          result.errors.push(...followUpResult.errors);
        }
      }

      // Circuit breaker: agentAdapter.sendMessage 把 inference error 塞进 errors 数组而不
      // throw（见 agentAdapter.ts:350-353），下面 catch 块接不到，要单独扫一遍 errors
      // 识别致命错误，否则余额不足时后续 case 会继续消耗 API 额度。
      const fatalError = result.errors.find(isNonRetryableError);
      if (fatalError && !this.aborted) {
        logger.error('Fatal inference error — aborting run', { testId: testCase.id, error: fatalError });
        this.aborted = true;
        this.abortReason = fatalError;
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
        workingDirectory,
      });

      result.score = assertionResult.score;
      result.reference_solution = testCase.reference_solution;
      // 评分权威：有声明断言（含 P1 expectations）= 确定性背书；
      // 零断言的自动 pass 只是 agent 没崩，标 self_check 不作能力证据。
      const hasDeterministicEvidence =
        countDeclaredAssertions(testCase.expect) > 0 ||
        (testCase.expectations?.length ?? 0) > 0;
      result.scoreAuthority = hasDeterministicEvidence ? 'deterministic_assertion' : 'self_check';

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
          workingDirectory,
          simTurns: result.simTurns,
          goalRun: result.goalRun,
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

      // WP1-2：agentAdapter 把 inference error 塞 errors 数组不 throw（同上
      // circuit breaker 注释）。零产出 + 全零分 + errors 里是瞬态基础设施错
      // → 这 case 没有能力数据，分流进 infra 桶而非记 failed。
      if (
        result.status === 'failed' &&
        result.score === 0 &&
        result.toolExecutions.length === 0 &&
        result.errors.length > 0 &&
        result.errors.some(isInfraExclusionError)
      ) {
        result.status = 'infra_excluded';
        result.failureStage = 'infra';
      }

      await this.attachTelemetryReplay(testCase, result, agent);

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
      // WP1-2：429/超时/5xx/网络 → infra 桶，不算 agent 能力失败
      if (isInfraExclusionError(message)) {
        result.status = 'infra_excluded';
        result.failureStage = 'infra';
      } else {
        result.status = 'failed';
      }
      result.failureReason = message || 'Unknown error';
      result.errors.push(message || String(error));
      this.emit({ type: 'error', testId: testCase.id, error: message });
      // Circuit breaker: 账号/余额/内容策略等持久性错误 → abort 整个 run，
      // 避免后续 case 重复踩同一个错误烧 API 费。
      if (isNonRetryableError(message)) {
        logger.error('Fatal inference error — aborting run', { testId: testCase.id, error: message });
        this.aborted = true;
        this.abortReason = message;
      }
    } finally {
      // B6b-①（审计 R1-M2）：超时/异常跳过了 try 内的断言前捕获时，在此兜底保留
      // 已发生的 goal_gate 观测事件（对称于 simTurns 的增量落账），供 infra 排查。
      // 只在未捕获时补——不许覆盖断言时刻的定格快照（审计 R2-M1 幽灵事件面）。
      if (testCase.goal_contract && result.goalRun === undefined) {
        result.goalRun = agent.getGoalRunRecord?.();
      }

      // 清理注入的附件（best-effort）
      for (const injected of injectedFiles) {
        try {
          await fs.rm(injected, { force: true });
        } catch (error) {
          logger.warn('Failed to remove injected case file', { testId: testCase.id, file: injected, error });
        }
      }

      // Run cleanup commands
      if (testCase.cleanup && testCase.cleanup.length > 0) {
        try {
          await this.runCommands(testCase.cleanup, 'cleanup', workingDirectory);
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
   * 附件注入：把 case 声明的本地文件拷进工作目录，返回落盘的绝对路径列表。
   * dest 必须落在工作目录内（防路径逃逸）；source 缺失直接抛错（不静默跳过，
   * 否则附件题会退化成"没有附件也硬答"的假阴性）。
   */
  private async injectCaseFiles(
    files: NonNullable<TestCase['files']>,
    workingDirectory: string,
  ): Promise<string[]> {
    const workDir = path.resolve(workingDirectory);
    const injected: string[] = [];
    for (const file of files) {
      const source = file.source.startsWith('~')
        ? path.join(os.homedir(), file.source.slice(1))
        : file.source;
      const dest = file.dest ?? path.basename(source);
      const destAbs = path.resolve(workDir, dest);
      const rel = path.relative(workDir, destAbs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`附件 dest 越界工作目录（dest escapes working directory）: ${dest}`);
      }
      try {
        await fs.access(source);
      } catch {
        throw new Error(`附件 source 不存在: ${source}`);
      }
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.copyFile(source, destAbs);
      injected.push(destAbs);
    }
    return injected;
  }

  /**
   * Run shell commands (setup/cleanup)
   */
  private async runCommands(
    commands: string[],
    phase: string,
    workingDirectory: string,
  ): Promise<void> {
    for (const cmd of commands) {
      try {
        await execAsync(cmd, { cwd: workingDirectory });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`${phase} command failed`, { cmd, error: message });
        throw new Error(`${phase} failed: ${cmd}`, { cause: error });
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
      prompt: testCase.prompt,
      followUpPrompts: testCase.follow_up_prompts,
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
    const durations = results
      .filter((r) => r.status !== 'skipped' && r.status !== 'infra_excluded')
      .map((r) => r.duration);

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
    defaultTimeout: parseInt(process.env.CODE_AGENT_TEST_TIMEOUT || '60000', 10),
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    ...overrides,
  };
}
