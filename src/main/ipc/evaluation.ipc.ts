// ============================================================================
// Evaluation IPC Handlers - 评测系统 IPC 处理器
// ============================================================================

import { app, ipcMain } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/ipc';
import { EVALUATION_CHANNELS } from '../../shared/ipc/channels';
import { EvaluationService } from '../evaluation/EvaluationService';
import { getSessionAnalyticsService } from '../evaluation/sessionAnalyticsService';
import { getSwissCheeseEvaluator, type ScoringConfigEntry } from '../evaluation/swissCheeseEvaluator';
import { AnnotationProxy } from '../evaluation/annotationProxy';
import type { EvaluationExportFormat } from '../../shared/types/evaluation';
import { scoreToGrade } from '../../shared/types/evaluation';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('EvaluationIPC');

/**
 * Classify a failure into a funnel stage.
 * Priority order (first match wins):
 *   1. security    — forbidden commands, sandbox violations
 *   2. compilation — tsc / syntax / compile errors
 *   3. self_repair — repair loop exhaustion
 *   4. verification — generic test/assertion failure (status === 'failed')
 *   5. llm_scoring — partial score (status === 'partial')
 */
type FailureStage = 'security' | 'compilation' | 'self_repair' | 'verification' | 'llm_scoring' | null;

/**
 * Map pipeline FailureStage names (from failureFunnel.ts) to local stage names.
 * Returns null if the value is not a recognized pipeline stage.
 */
function mapPipelineStage(pipelineStage: string | undefined): FailureStage {
  if (!pipelineStage) return null;
  const mapping: Record<string, FailureStage> = {
    security_guard: 'security',
    compilation_check: 'compilation',
    self_repair_check: 'self_repair',
    outcome_verification: 'verification',
    llm_scoring: 'llm_scoring',
    // Also accept the local names directly (for data written by experimentAdapter)
    security: 'security',
    compilation: 'compilation',
    self_repair: 'self_repair',
    verification: 'verification',
  };
  return mapping[pipelineStage] ?? null;
}

function classifyFailureStage(failureReason: string, status: string): FailureStage {
  const reason = failureReason.toLowerCase();

  // 1. Security: forbidden operations or sandbox violations
  if (/\bforbidden\b/.test(reason) || /\bsecurity\b/.test(reason) || /\bsandbox\b/.test(reason)) {
    return 'security';
  }
  // 2. Compilation: TypeScript, syntax, or compile-time errors
  if (/\bcompilation\b/.test(reason) || /\btsc\b/.test(reason) || /\bsyntax\b/.test(reason) || /\bcompile\b/.test(reason)) {
    return 'compilation';
  }
  // 3. Self-repair: repair loop failures
  if (/\bself[_-]?repair\b/.test(reason) || /\brepair\b/.test(reason)) {
    return 'self_repair';
  }
  // 4. Verification: test failed but no specific reason matched
  if (status === 'failed') {
    return 'verification';
  }
  // 5. LLM scoring: partial pass
  if (status === 'partial') {
    return 'llm_scoring';
  }
  return null;
}

/**
 * 注册评测相关的 IPC handlers
 */
export function registerEvaluationHandlers(): void {
  const service = EvaluationService.getInstance();

  // 执行评测
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_RUN,
    async (_event, payload: { sessionId: string; save?: boolean }) => {
      logger.info(`Running evaluation for session: ${payload.sessionId}`);
      return service.evaluateSession(payload.sessionId, { save: payload.save });
    }
  );

  // 获取评测结果
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_GET_RESULT,
    async (_event, evaluationId: string) => {
      return service.getResult(evaluationId);
    }
  );

  // 获取评测历史
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_LIST_HISTORY,
    async (_event, payload?: { sessionId?: string; limit?: number }) => {
      return service.listHistory(payload?.sessionId, payload?.limit);
    }
  );

  // 导出评测报告
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_EXPORT,
    async (
      _event,
      payload: {
        result: Parameters<typeof service.exportReport>[0];
        format: EvaluationExportFormat;
      }
    ) => {
      return service.exportReport(payload.result, payload.format);
    }
  );

  // 删除评测记录
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_DELETE,
    async (_event, evaluationId: string) => {
      return service.deleteResult(evaluationId);
    }
  );

  // ------------------------------------------------------------------------
  // Session Analytics v2/v3 - 分离客观指标和主观评测
  // ------------------------------------------------------------------------

  const analyticsService = getSessionAnalyticsService();

  // 获取客观指标（立即返回，不需要 LLM）
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_GET_OBJECTIVE_METRICS,
    async (_event, sessionId: string) => {
      logger.info(`Getting objective metrics for session: ${sessionId}`);
      return analyticsService.calculateObjectiveMetrics(sessionId);
    }
  );

  // 获取完整会话分析（客观指标 + 历史评测）
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_GET_SESSION_ANALYSIS,
    async (_event, sessionId: string) => {
      logger.info(`Getting session analysis for: ${sessionId}`);
      return analyticsService.getSessionAnalysis(sessionId);
    }
  );

  // 执行主观评测（v3: 瑞士奶酪 + Transcript 分析）
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_RUN_SUBJECTIVE,
    async (_event, payload: { sessionId: string; save?: boolean }) => {
      logger.info(`Running subjective evaluation for session: ${payload.sessionId}`);

      // 获取客观指标
      const objective = await analyticsService.calculateObjectiveMetrics(payload.sessionId);

      // 构建快照（优先使用遥测数据）
      const snapshot = await service.collectSessionData(payload.sessionId);

      // 使用瑞士奶酪评测器 (v3)
      const evaluator = getSwissCheeseEvaluator();

      // Load scoring config if available (Bug C2 fix)
      let scoringConfig: ScoringConfigEntry[] | undefined;
      try {
        const cfgPath = path.join(app.getPath('userData'), 'scoring-config.json');
        if (fs.existsSync(cfgPath)) {
          scoringConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        }
      } catch (e) {
        logger.warn('Failed to load scoring config, using defaults:', e);
      }

      const result = await evaluator.evaluate(snapshot, scoringConfig);

      if (!result) {
        throw new Error('Subjective evaluation failed');
      }

      // 构建返回结果
      const grade = scoreToGrade(result.overallScore);

      if (payload.save) {
        const fullResult = {
          id: `eval_${Date.now()}`,
          sessionId: payload.sessionId,
          timestamp: Date.now(),
          objective,
          subjective: {
            evaluatedAt: Date.now(),
            model: DEFAULT_MODEL,
            provider: DEFAULT_PROVIDER,
            dimensions: {},
            overallScore: result.overallScore,
            grade,
            summary: result.summary,
            suggestions: result.suggestions,
            consensus: result.consensus,
            reviewerCount: result.reviewerResults.length,
            passedReviewers: result.reviewerResults.filter(r => r.passed).length,
            transcriptMetrics: result.transcriptMetrics,
          },
        };

        await service.saveResult({
          id: fullResult.id,
          sessionId: payload.sessionId,
          timestamp: fullResult.timestamp,
          overallScore: result.overallScore,
          grade,
          metrics: evaluator.convertToMetrics(result),
          statistics: {
            duration: objective.duration,
            turnCount: objective.turnsCount,
            toolCallCount: objective.totalToolCalls,
            inputTokens: objective.totalInputTokens,
            outputTokens: objective.totalOutputTokens,
            totalCost: objective.estimatedCost,
          },
          topSuggestions: result.suggestions,
          aiSummary: result.summary,
          transcriptMetrics: result.transcriptMetrics,
          evalVersion: 'v1',
          judgeModel: DEFAULT_MODEL,
          judgePromptHash: result.promptHash,
        });
      }

      return {
        evaluatedAt: Date.now(),
        model: DEFAULT_MODEL,
        provider: DEFAULT_PROVIDER,
        dimensions: {},
        overallScore: result.overallScore,
        grade,
        summary: result.summary,
        suggestions: result.suggestions,
        consensus: result.consensus,
        reviewerCount: result.reviewerResults.length,
        passedReviewers: result.reviewerResults.filter(r => r.passed).length,
        reviewerResults: result.reviewerResults,
        codeVerification: result.codeVerification,
        aggregatedMetrics: result.aggregatedMetrics,
        transcriptMetrics: result.transcriptMetrics,
      };
    }
  );

  // @deprecated — Use LIST_EXPERIMENTS + LOAD_EXPERIMENT instead. Kept for backward compatibility.
  ipcMain.handle(EVALUATION_CHANNELS.LIST_TEST_REPORTS, async () => {
    return service.listTestReports();
  });

  // @deprecated — Use LOAD_EXPERIMENT instead. Kept for backward compatibility.
  ipcMain.handle(EVALUATION_CHANNELS.LOAD_TEST_REPORT, async (_event, filePath: string) => {
    return service.loadTestReport(filePath);
  });

  // Annotation store handlers (eval-harness)
  ipcMain.handle(EVALUATION_CHANNELS.SAVE_ANNOTATIONS, async (_event, annotation) => {
    const proxy = AnnotationProxy.getInstance();
    return proxy.saveAnnotation(annotation);
  });

  ipcMain.handle(EVALUATION_CHANNELS.GET_AXIAL_CODING, async () => {
    const proxy = AnnotationProxy.getInstance();
    return proxy.getAxialCoding();
  });


  // List test cases from YAML files
  ipcMain.handle(EVALUATION_CHANNELS.LIST_TEST_CASES, async () => {
    try {
      const { loadAllTestSuites } = await import('../testing/testCaseLoader');
      const path = await import('path');
      const { app } = await import('electron');

      // Try multiple possible test case directories
      const possibleDirs = [
        path.join(app.getAppPath(), '.claude', 'test-cases'),
        path.join(process.cwd(), '.claude', 'test-cases'),
      ];

      const allSuites = [];
      for (const dir of possibleDirs) {
        try {
          const suites = await loadAllTestSuites(dir);
          if (suites.length > 0) {
            allSuites.push(...suites.map(s => ({ ...s, sourceDir: dir })));
            break; // Use first directory that has test cases
          }
        } catch {
          // Try next directory
        }
      }

      return allSuites;
    } catch (error) {
      logger.error('Failed to list test cases:', error);
      return [];
    }
  });


  // Scoring config handlers
  const scoringConfigPath = path.join(
    app.getPath('userData'), 'scoring-config.json'
  );

  ipcMain.handle(EVALUATION_CHANNELS.GET_SCORING_CONFIG, async () => {
    try {
      if (fs.existsSync(scoringConfigPath)) {
        const data = fs.readFileSync(scoringConfigPath, 'utf-8');
        return JSON.parse(data);
      }
      return [];
    } catch (error) {
      logger.error('Failed to load scoring config:', error);
      return [];
    }
  });

  ipcMain.handle(EVALUATION_CHANNELS.UPDATE_SCORING_CONFIG, async (_event: any, config: ScoringConfigEntry[]) => {
    try {
      fs.writeFileSync(scoringConfigPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    } catch (error) {
      logger.error('Failed to save scoring config:', error);
      throw error;
    }
  });

  // ------------------------------------------------------------------------
  // ExcelMaster - Experiment CRUD (Layer 2)
  // ------------------------------------------------------------------------

  // List experiments
  ipcMain.handle(EVALUATION_CHANNELS.LIST_EXPERIMENTS, async (_event, limit?: number) => {
    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      return db.listExperiments(limit ?? 50);
    } catch (error) {
      logger.error('Failed to list experiments:', error);
      return [];
    }
  });

  // Load single experiment by ID
  ipcMain.handle(EVALUATION_CHANNELS.LOAD_EXPERIMENT, async (_event, id: string) => {
    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      return db.loadExperiment(id) ?? null;
    } catch (error) {
      logger.error('Failed to load experiment:', error);
      return null;
    }
  });

  // Failure funnel - derive funnel stages from stored experiment cases
  ipcMain.handle(EVALUATION_CHANNELS.GET_FAILURE_FUNNEL, async (_event, experimentId: string) => {
    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      const data = db.loadExperiment(experimentId);
      if (!data) return null;

      const cases = data.cases;

      // Build funnel counts using structured classifier
      const stageCounts: Record<string, number> = {
        security: 0,
        compilation: 0,
        self_repair: 0,
        verification: 0,
        llm_scoring: 0,
      };

      for (const c of cases) {
        let detail: Record<string, unknown> = {};
        try {
          detail = c.data_json ? JSON.parse(c.data_json) : {};
        } catch {
          logger.warn(`Skipping malformed data_json for case in experiment ${experimentId}`);
          continue;
        }
        // Prefer persisted failureStage from pipeline, fall back to string-matching classifier
        const persistedStage = mapPipelineStage(detail.failureStage as string | undefined);
        const failureReason: string = (detail.failureReason as string) || '';
        const stage = persistedStage ?? classifyFailureStage(failureReason, c.status);
        if (stage) {
          stageCounts[stage]++;
        }
      }

      const securityBlocked = stageCounts.security;
      const compilationBlocked = stageCounts.compilation;
      const selfRepairBlocked = stageCounts.self_repair;
      const verificationBlocked = stageCounts.verification;
      const llmPartial = stageCounts.llm_scoring;

      const total = cases.length;
      const stages = [
        { stage: 'security_guard' as const, passed: total - securityBlocked > 0, blockedCount: securityBlocked, details: [] as string[] },
        { stage: 'compilation_check' as const, passed: total - securityBlocked - compilationBlocked > 0, blockedCount: compilationBlocked, details: [] as string[] },
        { stage: 'self_repair_check' as const, passed: total - securityBlocked - compilationBlocked - selfRepairBlocked > 0, blockedCount: selfRepairBlocked, details: [] as string[] },
        { stage: 'outcome_verification' as const, passed: total - securityBlocked - compilationBlocked - selfRepairBlocked - verificationBlocked > 0, blockedCount: verificationBlocked, details: [] as string[] },
        { stage: 'llm_scoring' as const, passed: true, blockedCount: llmPartial, details: [] as string[] },
      ];

      return { experimentId, total, stages };
    } catch (error) {
      logger.error('Failed to get failure funnel:', error);
      return null;
    }
  });

  // Cross-experiment comparison - load multiple experiments
  ipcMain.handle(EVALUATION_CHANNELS.GET_CROSS_EXPERIMENT, async (_event, experimentIds: string[]) => {
    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      const results = [];
      for (const id of experimentIds) {
        const data = db.loadExperiment(id);
        if (data) {
          results.push(data);
        }
      }
      return results;
    } catch (error) {
      logger.error('Failed to get cross-experiment data:', error);
      return [];
    }
  });


  // Create experiment — wire the "Start Experiment" button to actual execution
  ipcMain.handle(EVALUATION_CHANNELS.CREATE_EXPERIMENT, async (
    _event,
    config: { name: string; model: string; testSetId: string; trialsPerCase: number; gitCommit: string }
  ) => {
    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const { v4: uuidv4 } = await import('uuid');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const db = getDatabase();
      const experimentId = uuidv4();

      // Auto-detect git commit if requested
      let gitCommit = config.gitCommit;
      if (gitCommit === 'auto-detect') {
        try {
          const { stdout } = await execAsync('git rev-parse --short HEAD');
          gitCommit = stdout.trim() || 'unknown';
        } catch {
          gitCommit = 'unknown';
        }
      }

      // Create experiment record in DB with status='pending'
      const now = Date.now();
      db.insertExperiment({
        id: experimentId,
        name: config.name,
        timestamp: now,
        model: config.model,
        provider: 'anthropic',
        scope: 'full',
        config_json: JSON.stringify({
          testSetId: config.testSetId,
          trialsPerCase: config.trialsPerCase,
          gitCommit,
        }),
        summary_json: JSON.stringify({
          total: 0,
          passed: 0,
          failed: 0,
          partial: 0,
          skipped: 0,
          passRate: 0,
          avgScore: 0,
          duration: 0,
          status: 'pending',
        }),
        source: 'ui-created',
        git_commit: gitCommit,
      });

      logger.info('Experiment created, starting async execution', { experimentId, name: config.name, model: config.model });

      // --- Async test execution (fire-and-forget, don't block IPC) ---
      (async () => {
        try {
          // 1. Update status to 'running'
          db.updateExperimentSummary(experimentId, JSON.stringify({
            total: 0, passed: 0, failed: 0, partial: 0, skipped: 0,
            passRate: 0, avgScore: 0, duration: 0, status: 'running',
          }));

          // 2. Load test suites
          const { loadAllTestSuites } = await import('../testing/testCaseLoader');
          const appPath = app.getAppPath();
          const possibleDirs = [
            path.join(appPath, '.claude', 'test-cases'),
            path.join(process.cwd(), '.claude', 'test-cases'),
            path.join(appPath, '.code-agent', 'test-cases'),
            path.join(process.cwd(), '.code-agent', 'test-cases'),
          ];

          let suites: Awaited<ReturnType<typeof loadAllTestSuites>> = [];
          for (const dir of possibleDirs) {
            try {
              suites = await loadAllTestSuites(dir);
              if (suites.length > 0) break;
            } catch { /* try next */ }
          }

          if (suites.length === 0) {
            throw new Error('No test suites found in any known directory');
          }

          // Filter by testSetId if specified
          let testCases = suites.flatMap(s => s.cases);
          if (config.testSetId && config.testSetId !== 'all') {
            if (config.testSetId.startsWith('subset:')) {
              // Load subset file and filter by caseIds
              const subsetFileName = config.testSetId.slice('subset:'.length);
              const subsetDir = path.join(app.getPath('userData'), 'test-subsets');
              const subsetPath = path.join(subsetDir, subsetFileName);
              try {
                const subsetContent = JSON.parse(fs.readFileSync(subsetPath, 'utf-8'));
                const subsetCaseIds = new Set<string>(subsetContent.caseIds || []);
                if (subsetCaseIds.size > 0) {
                  testCases = testCases.filter(tc => subsetCaseIds.has(tc.id));
                  logger.info('Filtered by subset', { subset: subsetFileName, filtered: testCases.length, total: suites.flatMap(s => s.cases).length });
                }
              } catch (subsetErr) {
                logger.warn('Failed to load subset file, running all cases', { subsetFileName, error: subsetErr instanceof Error ? subsetErr.message : String(subsetErr) });
              }
            } else {
              // Match suite name
              const matchingSuite = suites.find(s => s.name === config.testSetId);
              if (matchingSuite) {
                testCases = matchingSuite.cases;
              }
            }
          }

          logger.info('Loaded test cases for experiment', {
            experimentId,
            totalCases: testCases.length,
            suiteCount: suites.length,
          });

          // 3. Create agent adapter and test runner
          const { StandaloneAgentAdapter } = await import('../testing/agentAdapter');
          const { TestRunner, createDefaultConfig } = await import('../testing/testRunner');

          const workingDir = process.cwd();
          const agent = new StandaloneAgentAdapter({
            workingDirectory: workingDir,
            generation: 'experiment',
            modelConfig: {
              provider: 'anthropic',
              model: config.model,
              apiKey: process.env.ANTHROPIC_API_KEY,
            },
          });

          const testConfig = createDefaultConfig(workingDir, {
            filterIds: testCases.map(tc => tc.id),
            stopOnFailure: false,
            enableEvalCritic: false,
            enableTrajectoryAnalysis: false,
            trialsPerCase: config.trialsPerCase > 1 ? config.trialsPerCase : undefined,
          });

          const runner = new TestRunner(testConfig, agent);

          // 4. Run all tests
          const summary = await runner.runAll();

          // 5. Persist results via ExperimentAdapter (updates the experiment record)
          const { ExperimentAdapter } = await import('../evaluation/experimentAdapter');
          const adapter = new ExperimentAdapter(db);

          // Overwrite the experiment with actual results (ExperimentAdapter uses INSERT OR REPLACE)
          // We need to set the runId to our experimentId so it updates the same record
          (summary as any).runId = experimentId;
          summary.environment.model = config.model;
          summary.environment.provider = 'anthropic';
          await adapter.persistTestRun(summary);

          // 6. Update status to 'completed' with final stats
          db.updateExperimentSummary(experimentId, JSON.stringify({
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            partial: summary.partial,
            skipped: summary.skipped,
            passRate: summary.total > 0 ? summary.passed / summary.total : 0,
            avgScore: summary.averageScore,
            duration: summary.duration,
            status: 'completed',
          }));

          logger.info('Experiment completed successfully', {
            experimentId,
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            avgScore: summary.averageScore,
          });

        } catch (execError: unknown) {
          const errMsg = execError instanceof Error ? execError.message : String(execError);
          logger.error('Experiment execution failed', { experimentId, error: errMsg });

          // Update status to 'failed'
          try {
            db.updateExperimentSummary(experimentId, JSON.stringify({
              total: 0, passed: 0, failed: 0, partial: 0, skipped: 0,
              passRate: 0, avgScore: 0, duration: 0,
              status: 'failed',
              error: errMsg,
            }));
          } catch (dbError) {
            logger.error('Failed to update experiment status to failed', { experimentId, error: dbError });
          }
        }
      })();

      // Return immediately — execution continues in background
      return { experimentId, status: 'started' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create experiment', { error: msg });
      throw new Error(`Failed to create experiment: ${msg}`);
    }
  });


  // Snapshot handlers
  ipcMain.handle(EVALUATION_CHANNELS.GET_SNAPSHOT, async (_event, sessionId: string) => {
    try {
      const { getOrBuildSnapshot } = await import('../evaluation/snapshotBuilder');
      return getOrBuildSnapshot(sessionId);
    } catch (error) {
      logger.error('Failed to get snapshot:', error);
      return null;
    }
  });

  ipcMain.handle(EVALUATION_CHANNELS.BUILD_SNAPSHOT, async (_event, sessionId: string) => {
    try {
      const { buildSnapshot } = await import('../evaluation/snapshotBuilder');
      return buildSnapshot(sessionId);
    } catch (error) {
      logger.error('Failed to build snapshot:', error);
      return null;
    }
  });

  // Case detail handler (for CaseDetailPage)
  ipcMain.handle(EVALUATION_CHANNELS.GET_CASE_DETAIL, async (_event, payload: { experimentId: string; caseId: string }) => {
    try {
      const { getDatabase } = await import('../services/core/databaseService');
      const db = getDatabase();
      const data = db.loadExperiment(payload.experimentId);
      if (!data) return null;

      const caseData = data.cases.find(c => c.case_id === payload.caseId);
      if (!caseData) return null;

      // If case has session_id, try to get snapshot
      let snapshot = null;
      if (caseData.session_id) {
        try {
          const { getOrBuildSnapshot } = await import('../evaluation/snapshotBuilder');
          snapshot = getOrBuildSnapshot(caseData.session_id);
        } catch { /* best effort */ }
      }

      return { case: caseData, snapshot };
    } catch (error) {
      logger.error('Failed to get case detail:', error);
      return null;
    }
  });

  // Get current git commit hash
  ipcMain.handle(EVALUATION_CHANNELS.GET_GIT_COMMIT, async () => {
    try {
      const hash = execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
      return { hash, short: hash.slice(0, 7) };
    } catch {
      return { hash: 'unknown', short: 'unknown' };
    }
  });

  logger.info('Evaluation IPC handlers registered');
}

// ============================================================================
// Test Subset Management IPC Handlers
// ============================================================================

import { SUBSET_CHANNELS } from '../../shared/ipc/channels';

/**
 * 注册测试子集管理的 IPC handlers
 */
export function registerSubsetHandlers(): void {
  const subsetLogger = createLogger('SubsetIPC');

  const getSubsetDir = () => {
    const dir = path.join(app.getPath('userData'), 'test-subsets');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  };

  // Save a test subset
  ipcMain.handle(SUBSET_CHANNELS.SAVE, async (
    _event,
    subset: { name: string; description?: string; caseIds: string[] }
  ) => {
    try {
      const dir = getSubsetDir();
      const fileName = subset.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
      const filePath = path.join(dir, fileName);

      const data = {
        name: subset.name,
        description: subset.description || '',
        caseIds: subset.caseIds,
        createdAt: Date.now(),
      };

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      subsetLogger.info('Subset saved', { name: subset.name, count: subset.caseIds.length, path: filePath });

      return { success: true, path: filePath };
    } catch (error) {
      subsetLogger.error('Failed to save subset:', error);
      throw error;
    }
  });

  // List all saved subsets
  ipcMain.handle(SUBSET_CHANNELS.LIST, async () => {
    try {
      const dir = getSubsetDir();
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const subsets = [];

      for (const file of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          subsets.push({
            name: content.name || file.replace('.json', ''),
            description: content.description || '',
            caseIds: content.caseIds || [],
            createdAt: content.createdAt || 0,
            fileName: file,
          });
        } catch {
          subsetLogger.warn(`Skipping malformed subset file: ${file}`);
        }
      }

      return subsets.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      subsetLogger.error('Failed to list subsets:', error);
      return [];
    }
  });

  // Load a specific subset
  ipcMain.handle(SUBSET_CHANNELS.LOAD, async (_event, fileName: string) => {
    try {
      const filePath = path.join(getSubsetDir(), fileName);
      if (!fs.existsSync(filePath)) return null;

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        name: content.name,
        description: content.description || '',
        caseIds: content.caseIds || [],
        createdAt: content.createdAt || 0,
      };
    } catch (error) {
      subsetLogger.error('Failed to load subset:', error);
      return null;
    }
  });

  // Delete a subset
  ipcMain.handle(SUBSET_CHANNELS.DELETE, async (_event, fileName: string) => {
    try {
      const filePath = path.join(getSubsetDir(), fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        subsetLogger.info('Subset deleted', { fileName });
        return true;
      }
      return false;
    } catch (error) {
      subsetLogger.error('Failed to delete subset:', error);
      return false;
    }
  });

  subsetLogger.info('Test subset IPC handlers registered');
}
