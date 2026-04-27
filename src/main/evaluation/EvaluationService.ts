// ============================================================================
// EvaluationService - 评测服务主类
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { getServiceRegistry } from '../services/serviceRegistry';
import { getTestDirs, resolvePathWithFallback } from '../config';
import type {
  EvaluationResult,
  EvaluationMetric,
  EvaluationExportFormat,
  BaselineComparison,
} from '../../shared/contract/evaluation';
import {
  EvaluationDimension,
  DIMENSION_NAMES,
  scoreToGrade,
} from '../../shared/contract/evaluation';
import type { TestReportListItem, TestRunReport } from '../../shared/ipc';
import type { SessionSnapshot, DimensionEvaluator } from './types';
import {
  TaskCompletionEvaluator,
  ToolEfficiencyEvaluator,
  DialogQualityEvaluator,
  CodeQualityEvaluator,
  PerformanceEvaluator,
  SecurityEvaluator,
} from './metrics';
import { getSwissCheeseEvaluator } from './swissCheeseEvaluator';
import { getTelemetryQueryService } from './telemetryQueryService';
import { getOrBuildSnapshot } from './snapshotBuilder';

const logger = createLogger('EvaluationService');

/**
 * 会话评测服务
 */
export class EvaluationService {
  private static instance: EvaluationService;
  private evaluators: Map<EvaluationDimension, DimensionEvaluator>;

  private constructor() {
    this.evaluators = new Map();
    this.evaluators.set(
      EvaluationDimension.TASK_COMPLETION,
      new TaskCompletionEvaluator()
    );
    this.evaluators.set(
      EvaluationDimension.TOOL_EFFICIENCY,
      new ToolEfficiencyEvaluator()
    );
    this.evaluators.set(
      EvaluationDimension.DIALOG_QUALITY,
      new DialogQualityEvaluator()
    );
    this.evaluators.set(
      EvaluationDimension.CODE_QUALITY,
      new CodeQualityEvaluator()
    );
    this.evaluators.set(
      EvaluationDimension.PERFORMANCE,
      new PerformanceEvaluator()
    );
    this.evaluators.set(
      EvaluationDimension.SECURITY,
      new SecurityEvaluator()
    );
  }

  async dispose(): Promise<void> {
    // EvaluationService is stateless, nothing to dispose
  }

  static getInstance(): EvaluationService {
    if (!EvaluationService.instance) {
      EvaluationService.instance = new EvaluationService();
      getServiceRegistry().register('EvaluationService', EvaluationService.instance);
    }
    return EvaluationService.instance;
  }

  /**
   * 获取数据库实例（带空值检查）
   */
  private getDbInstance() {
    const db = getDatabase();
    if (!db.isReady) {
      throw new Error('Database not initialized');
    }
    return db.getDb()!;
  }

  /**
   * 评测会话
   * 优先使用瑞士奶酪多层评测，失败时回退到简单 AI 评测，再失败回退到规则评测
   */
  async evaluateSession(
    sessionId: string,
    options: { save?: boolean; useAI?: boolean } = {}
  ): Promise<EvaluationResult> {
    logger.info(`Evaluating session: ${sessionId}`);

    // Phase 1: 先构建/获取 EvalSnapshot
    const evalSnapshot = getOrBuildSnapshot(sessionId);
    if (evalSnapshot) {
      logger.info('EvalSnapshot ready', {
        snapshotId: evalSnapshot.snapshot_id,
        toolCalls: evalSnapshot.total_tool_calls,
      });
    }

    // 收集会话数据（用于评测引擎）
    const snapshot = await this.collectSessionData(sessionId);

    let metrics: EvaluationMetric[] = [];
    let overallScore: number;
    let allSuggestions: string[] = [];
    let aiSummary: string | undefined;

    // 默认使用 AI 评测
    const useAI = options.useAI !== false;

    if (useAI) {
      // 瑞士奶酪多层评测，失败直接走规则
      try {
        logger.info('Attempting Swiss Cheese multi-agent evaluation...');
        const swissCheeseEvaluator = getSwissCheeseEvaluator();
        const scResult = await swissCheeseEvaluator.evaluate(snapshot);

        if (scResult) {
          metrics = swissCheeseEvaluator.convertToMetrics(scResult);
          overallScore = scResult.overallScore;
          allSuggestions = scResult.suggestions || [];
          aiSummary = scResult.summary;
          logger.info('Swiss Cheese evaluation succeeded', {
            overallScore,
            consensus: scResult.consensus,
            reviewerCount: scResult.reviewerResults.length
          });
        } else {
          throw new Error('Swiss Cheese evaluation returned null');
        }
      } catch (scError) {
        // 瑞士奶酪评测失败，直接回退到规则评测（移除 AIEvaluator 中间层）
        logger.warn('Swiss Cheese evaluation failed, falling back to rule-based', { error: scError });
        const ruleResult = await this.runRuleBasedEvaluation(snapshot);
        metrics = ruleResult.metrics;
        overallScore = ruleResult.overallScore;
        allSuggestions = ruleResult.suggestions;
      }
    } else {
      // 使用规则评测
      const ruleResult = await this.runRuleBasedEvaluation(snapshot);
      metrics = ruleResult.metrics;
      overallScore = ruleResult.overallScore;
      allSuggestions = ruleResult.suggestions;
    }

    const replay = await getTelemetryQueryService().getStructuredReplay(sessionId).catch(() => null);

    const result: EvaluationResult = {
      id: uuidv4(),
      sessionId,
      replayKey: replay?.traceIdentity.replayKey || sessionId,
      timestamp: Date.now(),
      overallScore,
      grade: scoreToGrade(overallScore),
      metrics,
      statistics: {
        duration: snapshot.endTime - snapshot.startTime,
        turnCount: snapshot.messages.filter((m) => m.role === 'user').length,
        toolCallCount: snapshot.toolCalls.length,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        totalCost: snapshot.totalCost,
      },
      topSuggestions: allSuggestions.slice(0, 5),
      aiSummary,
      telemetryCompleteness: replay?.summary.telemetryCompleteness,
      // 版本化字段
      snapshotId: evalSnapshot?.snapshot_id,
      evalVersion: evalSnapshot ? 'v1' : 'legacy',
    };

    // 基线对比
    try {
      const comparison = await this.compareWithBaseline(result);
      if (comparison) {
        result.baselineComparison = comparison;
        logger.info('Baseline comparison', {
          delta: comparison.delta,
          regressions: comparison.regressions.length,
          improvements: comparison.improvements.length,
        });
      }
    } catch (err) {
      logger.warn('Baseline comparison failed', { error: err });
    }

    // 可选: Trajectory 分析（不影响主流程）
    try {
      const { getSessionEventService } = await import('./sessionEventService');
      const { TrajectoryBuilder } = await import('./trajectory/trajectoryBuilder');
      const { DeviationDetector } = await import('./trajectory/deviationDetector');

      const eventService = getSessionEventService();
      const events = eventService.getSessionEvents(sessionId);

      if (events.length > 0) {
        const builder = new TrajectoryBuilder();
        const trajectory = builder.buildFromEvents(
          events.map(e => ({
            event_type: e.eventType,
            event_data: (e.eventData as Record<string, unknown>) || {},
            timestamp: String(e.timestamp),
          }))
        );
        trajectory.sessionId = sessionId;

        const detector = new DeviationDetector();
        const deviations = detector.detectByRules(trajectory);
        trajectory.deviations = deviations;

        result.trajectoryAnalysis = {
          deviations: deviations.map(d => ({
            stepIndex: d.stepIndex,
            type: d.type,
            description: d.description,
            severity: d.severity,
            suggestedFix: d.suggestedFix,
          })),
          efficiency: {
            totalSteps: trajectory.efficiency.totalSteps,
            effectiveSteps: trajectory.efficiency.effectiveSteps,
            redundantSteps: trajectory.efficiency.redundantSteps,
            efficiency: trajectory.efficiency.efficiency,
          },
          recoveryPatterns: trajectory.recoveryPatterns.map(rp => ({
            errorStepIndex: rp.errorStepIndex,
            recoveryStepIndex: rp.recoveryStepIndex,
            attempts: rp.attempts,
            strategy: rp.strategy,
            successful: rp.successful,
          })),
          outcome: trajectory.summary.outcome,
        };

        // v2.5 Phase 2: rule-based failure attribution.
        // Phase 7 (A): opt-in LLM fallback when CODE_AGENT_EVAL_LLM_ENABLED=1.
        // Silent fallback to rules-only if env flag is off or API key missing.
        try {
          const { FailureAttributor } = await import('./trajectory/attribution');
          const { buildAttributionChatFnFromEnv } = await import('./llmChatFactory');
          const llmFn = await buildAttributionChatFnFromEnv();
          const attribution = await new FailureAttributor().attribute(trajectory, {
            enableLLM: llmFn !== null,
            llmFn: llmFn ?? undefined,
          });
          if (result.trajectoryAnalysis) {
            result.trajectoryAnalysis.failureAttribution = {
              rootCause: attribution.rootCause,
              causalChain: attribution.causalChain,
              relatedRegressionCases: attribution.relatedRegressionCases,
              llmUsed: attribution.llmUsed,
              durationMs: attribution.durationMs,
            };
          }
        } catch (attrError) {
          logger.debug('Failure attribution skipped', { error: attrError });
        }

        logger.info('Trajectory analysis complete', {
          deviations: deviations.length,
          efficiency: trajectory.efficiency.efficiency,
          outcome: trajectory.summary.outcome,
        });
      }
    } catch (trajError) {
      logger.debug('Trajectory analysis skipped', { error: trajError });
    }

    // 可选保存结果
    if (options.save) {
      await this.saveResult(result);
    }

    logger.info(`Evaluation complete: score=${overallScore}, grade=${result.grade}`);
    return result;
  }

  /**
   * 运行规则评测（回退方案）
   */
  private async runRuleBasedEvaluation(snapshot: SessionSnapshot): Promise<{
    metrics: EvaluationMetric[];
    overallScore: number;
    suggestions: string[];
  }> {
    const metrics: EvaluationMetric[] = [];
    for (const evaluator of this.evaluators.values()) {
      const metric = await evaluator.evaluate(snapshot);
      metrics.push(metric);
    }

    const overallScore = Math.round(
      metrics.reduce((acc, m) => acc + m.score * m.weight, 0)
    );

    const suggestions = metrics
      .flatMap((m) => m.suggestions || [])
      .slice(0, 5);

    return { metrics, overallScore, suggestions };
  }

  /**
   * 获取评测结果
   */
  async getResult(evaluationId: string): Promise<EvaluationResult | null> {
    const dbInstance = this.getDbInstance();
    const row = dbInstance
      .prepare('SELECT data FROM evaluations WHERE id = ?')
      .get(evaluationId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  /**
   * 获取评测历史
   */
  async listHistory(
    sessionId?: string,
    limit = 20
  ): Promise<EvaluationResult[]> {
    const dbInstance = this.getDbInstance();

    let query = 'SELECT data FROM evaluations';
    const params: unknown[] = [];

    if (sessionId) {
      query += ' WHERE session_id = ?';
      params.push(sessionId);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = dbInstance.prepare(query).all(...params) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  /**
   * 列出测试报告（.json）文件
   */
  async listTestReports(): Promise<TestReportListItem[]> {
    const resultsDir = await this.resolveTestResultsDir();

    try {
      const entries = await fs.readdir(resultsDir, { withFileTypes: true });
      const reportFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .filter((entry) => entry.name === 'latest-report.json' || /^report-[\w]+\.json$/.test(entry.name));

      const reports = await Promise.all(
        reportFiles.map(async (entry) => {
          const filePath = path.join(resultsDir, entry.name);
          try {
            const report = await this.loadTestReport(filePath);
            if (!report) return null;

            return {
              fileName: entry.name,
              filePath,
              timestamp: Number(report.endTime) || Number(report.startTime) || 0,
              model: report.environment?.model || 'unknown',
              provider: report.environment?.provider || 'unknown',
              total: Number(report.total) || 0,
              passed: Number(report.passed) || 0,
              failed: Number(report.failed) || 0,
              partial: Number(report.partial) || 0,
              averageScore: Number(report.averageScore) || 0,
            } satisfies TestReportListItem;
          } catch (error) {
            logger.warn('Failed to parse test report file', { filePath, error });
            return null;
          }
        })
      );

      return reports
        .filter((item): item is TestReportListItem => item !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  /**
   * 加载指定测试报告
   */
  async loadTestReport(filePath: string): Promise<TestRunReport | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as TestRunReport;
    } catch (error) {
      logger.warn('Failed to load test report', { filePath, error });
      return null;
    }
  }

  private async resolveTestResultsDir(): Promise<string> {
    if (process.env.AUTO_TEST_RESULTS_DIR) {
      return process.env.AUTO_TEST_RESULTS_DIR;
    }

    const testDirs = getTestDirs(process.cwd());
    const resolved = await resolvePathWithFallback(testDirs.results.new, testDirs.results.legacy);
    return resolved.resolved;
  }

  /**
   * 删除评测结果
   */
  async deleteResult(evaluationId: string): Promise<boolean> {
    const dbInstance = this.getDbInstance();
    const result = dbInstance
      .prepare('DELETE FROM evaluations WHERE id = ?')
      .run(evaluationId);
    return result.changes > 0;
  }

  /**
   * 导出评测报告
   */
  exportReport(result: EvaluationResult, format: EvaluationExportFormat): string {
    if (format === 'json') {
      return JSON.stringify(result, null, 2);
    }

    // Markdown format
    const lines: string[] = [];
    lines.push(`# 会话评测报告`);
    lines.push('');
    lines.push(`- **评测时间**: ${new Date(result.timestamp).toLocaleString()}`);
    lines.push(`- **会话 ID**: ${result.sessionId}`);
    lines.push(`- **综合得分**: ${result.overallScore} (${result.grade})`);
    lines.push('');
    lines.push('## 详细指标');
    lines.push('');
    lines.push('| 维度 | 分数 | 权重 |');
    lines.push('|------|------|------|');
    for (const metric of result.metrics) {
      const name = DIMENSION_NAMES[metric.dimension];
      lines.push(`| ${name} | ${metric.score} | ${(metric.weight * 100).toFixed(0)}% |`);
    }
    lines.push('');
    lines.push('## 统计信息');
    lines.push('');
    lines.push(`- 会话时长: ${Math.round(result.statistics.duration / 1000)}秒`);
    lines.push(`- 交互轮次: ${result.statistics.turnCount}`);
    lines.push(`- 工具调用: ${result.statistics.toolCallCount}`);
    lines.push(`- Token 消耗: ${result.statistics.inputTokens + result.statistics.outputTokens}`);
    lines.push(`- 总成本: $${result.statistics.totalCost.toFixed(4)}`);
    lines.push('');

    if (result.topSuggestions.length > 0) {
      lines.push('## 改进建议');
      lines.push('');
      for (const suggestion of result.topSuggestions) {
        lines.push(`- ${suggestion}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 收集会话数据 — 优先从遥测表读取结构化数据，fallback 到旧 messages/tool_uses 表
   */
  async collectSessionData(sessionId: string): Promise<SessionSnapshot> {
    const dbInstance = this.getDbInstance();

    // 尝试从遥测表获取结构化数据
    const telemetryData = this.collectFromTelemetry(dbInstance, sessionId);
    if (telemetryData) {
      logger.info('Collected session data from telemetry tables', {
        sessionId,
        turns: telemetryData.turns.length,
        inputTokens: telemetryData.inputTokens,
      });
      return telemetryData;
    }

    // Fallback: 从旧的 messages/tool_uses 表获取扁平数据
    logger.info('Telemetry data not available, falling back to messages/tool_uses tables', { sessionId });
    return this.collectFromLegacyTables(dbInstance, sessionId);
  }

  /**
   * 从 telemetry 表收集结构化数据
   */
  private collectFromTelemetry(
    _db: ReturnType<typeof this.getDbInstance>,
    sessionId: string
  ): SessionSnapshot | null {
    return getTelemetryQueryService().getSessionSnapshot(sessionId);
  }

  /**
   * Fallback: 从旧的 messages/tool_uses 表获取扁平数据
   */
  private collectFromLegacyTables(
    db: ReturnType<typeof this.getDbInstance>,
    sessionId: string
  ): SessionSnapshot {
    // 获取消息
    const messageRows = db
      .prepare(
        `SELECT id, role, content, timestamp
         FROM messages
         WHERE session_id = ?
         ORDER BY timestamp ASC`
      )
      .all(sessionId) as {
      id: string;
      role: string;
      content: string;
      timestamp: number;
    }[];

    const messages = messageRows.map((row) => ({
      id: row.id,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      timestamp: row.timestamp,
    }));

    // 获取工具调用
    let toolCalls: SessionSnapshot['toolCalls'] = [];
    try {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tool_uses'`)
        .get();

      if (tableExists) {
        const toolUseRows = db
          .prepare(
            `SELECT id, tool_name as name, input as args, output as result,
                    success, duration_ms as duration, timestamp
             FROM tool_uses
             WHERE session_id = ?
             ORDER BY timestamp ASC`
          )
          .all(sessionId) as {
          id: string;
          name: string;
          args: string;
          result: string | null;
          success: number;
          duration: number;
          timestamp: number;
        }[];

        toolCalls = toolUseRows.map((row) => ({
          id: row.id,
          name: row.name,
          args: JSON.parse(row.args || '{}'),
          result: row.result || undefined,
          success: row.success === 1,
          duration: row.duration || 0,
          timestamp: row.timestamp,
        }));
      }
    } catch {
      // 表不存在或查询失败
    }

    // 获取会话统计
    const sessionRow = db
      .prepare(`SELECT created_at, updated_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { created_at: number; updated_at: number } | undefined;

    const startTime = messages[0]?.timestamp || sessionRow?.created_at || Date.now();
    const endTime = messages[messages.length - 1]?.timestamp || sessionRow?.updated_at || Date.now();

    return {
      sessionId,
      messages,
      toolCalls,
      turns: [], // 旧数据无 turn 级结构
      startTime,
      endTime,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      qualitySignals: {
        totalRetries: 0,
        errorRecoveries: 0,
        compactionCount: 0,
        circuitBreakerTrips: 0,
        selfRepairAttempts: 0,
        selfRepairSuccesses: 0,
        verificationActions: 0,
      },
    };
  }

  /**
   * 与历史基线对比，检测显著退化或改善
   */
  async compareWithBaseline(current: EvaluationResult): Promise<BaselineComparison | null> {
    const history = await this.listHistory(undefined, 10);
    if (history.length < 3) return null; // 数据不够

    const recentHistory = history.slice(0, 5);
    const baselineScore = Math.round(
      recentHistory.reduce((sum, r) => sum + r.overallScore, 0) / recentHistory.length
    );
    const delta = current.overallScore - baselineScore;

    const regressions: string[] = [];
    const improvements: string[] = [];

    // 按维度对比
    for (const metric of current.metrics) {
      const historicalScores = history
        .flatMap((r) => r.metrics)
        .filter((m) => m.dimension === metric.dimension)
        .map((m) => m.score);
      if (historicalScores.length === 0) continue;
      const avg = historicalScores.reduce((a, b) => a + b, 0) / historicalScores.length;
      const diff = metric.score - avg;
      const dimName = DIMENSION_NAMES[metric.dimension] || metric.dimension;
      if (diff < -15) {
        regressions.push(`${dimName}: ${metric.score} (历史均值 ${Math.round(avg)})`);
      }
      if (diff > 15) {
        improvements.push(`${dimName}: ${metric.score} (历史均值 ${Math.round(avg)})`);
      }
    }

    return { delta, baselineScore, regressions, improvements };
  }

  /**
   * 保存评测结果（含版本化元数据）
   */
  async saveResult(result: EvaluationResult): Promise<void> {
    const dbInstance = this.getDbInstance();

    // 自动填充版本化字段
    if (!result.evalVersion) {
      result.evalVersion = result.snapshotId ? 'v1' : 'legacy';
    }

    dbInstance
      .prepare(
        `INSERT INTO evaluations (id, session_id, timestamp, score, grade, data, snapshot_id, eval_version, rubric_version, judge_model, judge_prompt_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.sessionId,
        result.timestamp,
        result.overallScore,
        result.grade,
        JSON.stringify(result),
        result.snapshotId || null,
        result.evalVersion,
        result.rubricVersion || null,
        result.judgeModel || null,
        result.judgePromptHash || null,
      );
  }
}
