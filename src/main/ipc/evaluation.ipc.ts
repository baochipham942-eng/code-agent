// ============================================================================
// Evaluation IPC Handlers - 评测系统 IPC 处理器
// ============================================================================

import { app, ipcMain } from 'electron';
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

  // List test reports
  ipcMain.handle(EVALUATION_CHANNELS.LIST_TEST_REPORTS, async () => {
    return service.listTestReports();
  });

  // Load single test report by path
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

  ipcMain.handle(EVALUATION_CHANNELS.UPDATE_SCORING_CONFIG, async (_event: Electron.IpcMainInvokeEvent, config: ScoringConfigEntry[]) => {
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
        const failureReason: string = (detail.failureReason as string) || '';
        const stage = classifyFailureStage(failureReason, c.status);
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

  logger.info('Evaluation IPC handlers registered');
}
