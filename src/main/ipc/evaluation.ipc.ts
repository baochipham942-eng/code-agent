// ============================================================================
// Evaluation IPC Handlers - 评测系统 IPC 处理器
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { EvaluationService } from '../evaluation';
import { getSessionAnalyticsService } from '../evaluation/sessionAnalyticsService';
import { getSwissCheeseEvaluator } from '../evaluation/swissCheeseEvaluator';
import type { EvaluationExportFormat, EvaluationGrade } from '../../shared/types/evaluation';
import { scoreToGrade } from '../../shared/types/evaluation';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('EvaluationIPC');

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
  // Session Analytics v2 - 分离客观指标和主观评测
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

  // 执行主观评测（按需调用，使用瑞士奶酪多层评测）
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_RUN_SUBJECTIVE,
    async (_event, payload: { sessionId: string; save?: boolean }) => {
      logger.info(`Running subjective evaluation for session: ${payload.sessionId}`);

      try {
        // 先获取会话数据
        logger.info('Step 1: Getting objective metrics...');
        const objective = await analyticsService.calculateObjectiveMetrics(payload.sessionId);
        logger.info('Step 1 completed', { turnsCount: objective.turnsCount });

        // 构建快照用于评测
        logger.info('Step 2: Collecting session data...');
        const snapshot = await service['collectSessionData'](payload.sessionId);
        logger.info('Step 2 completed', { messageCount: snapshot.messages.length });

        // 使用瑞士奶酪评测器
        logger.info('Step 3: Running Swiss Cheese evaluation...');
        const evaluator = getSwissCheeseEvaluator();
        const result = await evaluator.evaluate(snapshot);
        logger.info('Step 3 completed', { hasResult: !!result });

        if (!result) {
          throw new Error('Subjective evaluation failed');
        }

        // 如果需要保存
        if (payload.save) {
          const grade = scoreToGrade(result.overallScore);
          const fullResult = {
            id: `eval_${Date.now()}`,
            sessionId: payload.sessionId,
            timestamp: Date.now(),
            objective,
            subjective: {
              evaluatedAt: Date.now(),
              model: 'kimi-k2.5',
              provider: 'moonshot',
              dimensions: {},
              overallScore: result.overallScore,
              grade,
              summary: result.summary,
              suggestions: result.suggestions,
              consensus: result.consensus,
              reviewerCount: result.reviewerResults.length,
              passedReviewers: result.reviewerResults.filter(r => r.passed).length,
            },
          };

          // 保存到数据库
          await service['saveResult']({
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
          });
        }

        return {
          evaluatedAt: Date.now(),
          model: 'kimi-k2.5',
          provider: 'moonshot',
          dimensions: {},
          overallScore: result.overallScore,
          grade: scoreToGrade(result.overallScore),
          summary: result.summary,
          suggestions: result.suggestions,
          consensus: result.consensus,
          reviewerCount: result.reviewerResults.length,
          passedReviewers: result.reviewerResults.filter(r => r.passed).length,
          reviewerResults: result.reviewerResults,
          codeVerification: result.codeVerification,
          aggregatedMetrics: result.aggregatedMetrics,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Subjective evaluation failed', { error: errorMsg, sessionId: payload.sessionId });
        throw error;
      }
    }
  );

  logger.info('Evaluation IPC handlers registered');
}
