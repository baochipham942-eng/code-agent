// ============================================================================
// EvaluationService - 评测服务主类
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type {
  EvaluationResult,
  EvaluationMetric,
  EvaluationExportFormat,
} from '../../shared/types/evaluation';
import {
  EvaluationDimension,
  DIMENSION_NAMES,
  scoreToGrade,
} from '../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator, TurnSnapshot, QualitySignals } from './types';
import {
  TaskCompletionEvaluator,
  ToolEfficiencyEvaluator,
  DialogQualityEvaluator,
  CodeQualityEvaluator,
  PerformanceEvaluator,
  SecurityEvaluator,
} from './metrics';
import { getAIEvaluator } from './aiEvaluator';
import { getSwissCheeseEvaluator } from './swissCheeseEvaluator';

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

  static getInstance(): EvaluationService {
    if (!EvaluationService.instance) {
      EvaluationService.instance = new EvaluationService();
    }
    return EvaluationService.instance;
  }

  /**
   * 获取数据库实例（带空值检查）
   */
  private getDbInstance() {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      throw new Error('Database not initialized');
    }
    return dbInstance;
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

    // 收集会话数据
    const snapshot = await this.collectSessionData(sessionId);

    let metrics: EvaluationMetric[] = [];
    let overallScore: number;
    let allSuggestions: string[] = [];
    let aiSummary: string | undefined;

    // 默认使用 AI 评测
    const useAI = options.useAI !== false;

    if (useAI) {
      // 优先尝试瑞士奶酪多层评测
      try {
        logger.info('Attempting Swiss Cheese multi-agent evaluation...');
        const swissCheeseEvaluator = getSwissCheeseEvaluator();
        const scResult = await swissCheeseEvaluator.evaluate(snapshot);

        if (scResult) {
          // 瑞士奶酪评测成功
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
        // 瑞士奶酪评测失败，回退到简单 AI 评测
        logger.warn('Swiss Cheese evaluation failed, trying simple AI evaluation', { error: scError });

        try {
          const aiEvaluator = getAIEvaluator();
          const aiResult = await aiEvaluator.evaluate(snapshot);

          if (aiResult) {
            metrics = aiEvaluator.convertToMetrics(aiResult);
            overallScore = aiResult.overallScore;
            allSuggestions = aiResult.suggestions || [];
            aiSummary = aiResult.summary;
            logger.info('AI evaluation succeeded', { overallScore });
          } else {
            throw new Error('AI evaluation returned null');
          }
        } catch (aiError) {
          // AI 评测也失败，回退到规则评测
          logger.warn('AI evaluation failed, falling back to rule-based', { error: aiError });
          const ruleResult = await this.runRuleBasedEvaluation(snapshot);
          metrics = ruleResult.metrics;
          overallScore = ruleResult.overallScore;
          allSuggestions = ruleResult.suggestions;
        }
      }
    } else {
      // 使用规则评测
      const ruleResult = await this.runRuleBasedEvaluation(snapshot);
      metrics = ruleResult.metrics;
      overallScore = ruleResult.overallScore;
      allSuggestions = ruleResult.suggestions;
    }

    const result: EvaluationResult = {
      id: uuidv4(),
      sessionId,
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
    };

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
    db: ReturnType<typeof this.getDbInstance>,
    sessionId: string
  ): SessionSnapshot | null {
    try {
      // 检查 telemetry_turns 表是否存在且有数据
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_turns'`)
        .get();
      if (!tableExists) return null;

      const turnCount = db
        .prepare(`SELECT COUNT(*) as cnt FROM telemetry_turns WHERE session_id = ?`)
        .get(sessionId) as { cnt: number };
      if (!turnCount || turnCount.cnt === 0) return null;

      // 获取 telemetry_session 级聚合数据
      const sessionRow = db
        .prepare(`SELECT * FROM telemetry_sessions WHERE id = ?`)
        .get(sessionId) as Record<string, unknown> | undefined;

      // 获取所有 turns
      const turnRows = db
        .prepare(`SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY turn_number ASC`)
        .all(sessionId) as Record<string, unknown>[];

      // 获取所有 tool_calls
      const toolCallRows = db
        .prepare(`SELECT * FROM telemetry_tool_calls WHERE session_id = ? ORDER BY timestamp ASC`)
        .all(sessionId) as Record<string, unknown>[];

      // 构建 TurnSnapshot[]
      const turns: TurnSnapshot[] = turnRows.map(row => {
        const qualitySignalsStr = row.quality_signals as string | null;
        let qualitySignals: Record<string, unknown> = {};
        try {
          if (qualitySignalsStr) qualitySignals = JSON.parse(qualitySignalsStr);
        } catch { /* ignore */ }

        const turnToolCalls = toolCallRows
          .filter(tc => tc.turn_id === row.id)
          .map(tc => ({
            id: tc.id as string,
            name: tc.name as string,
            args: {},
            result: (tc.result_summary as string) || undefined,
            success: (tc.success as number) === 1,
            duration: (tc.duration_ms as number) || 0,
            timestamp: tc.timestamp as number,
            turnId: tc.turn_id as string,
            index: (tc.idx as number) || 0,
            parallel: (tc.parallel as number) === 1,
          }));

        return {
          turnNumber: row.turn_number as number,
          userPrompt: (row.user_prompt as string) || '',
          assistantResponse: (row.assistant_response as string) || '',
          toolCalls: turnToolCalls,
          intentPrimary: (row.intent_primary as string) || 'unknown',
          outcomeStatus: (row.outcome_status as string) || 'unknown',
          thinkingContent: (row.thinking_content as string) || undefined,
          durationMs: (row.duration_ms as number) || 0,
          inputTokens: (row.total_input_tokens as number) || 0,
          outputTokens: (row.total_output_tokens as number) || 0,
        };
      });

      // 构建 messages（从 turns 重建，保持兼容）
      const messages = turns.flatMap(turn => {
        const msgs = [];
        if (turn.userPrompt) {
          msgs.push({
            id: `turn-${turn.turnNumber}-user`,
            role: 'user' as const,
            content: turn.userPrompt,
            timestamp: 0,
          });
        }
        if (turn.assistantResponse) {
          msgs.push({
            id: `turn-${turn.turnNumber}-assistant`,
            role: 'assistant' as const,
            content: turn.assistantResponse,
            timestamp: 0,
          });
        }
        return msgs;
      });

      // 构建 toolCalls（扁平列表，保持兼容）
      const toolCalls = toolCallRows.map(tc => ({
        id: tc.id as string,
        name: tc.name as string,
        args: {},
        result: (tc.result_summary as string) || undefined,
        success: (tc.success as number) === 1,
        duration: (tc.duration_ms as number) || 0,
        timestamp: tc.timestamp as number,
        turnId: tc.turn_id as string,
        index: (tc.idx as number) || 0,
        parallel: (tc.parallel as number) === 1,
      }));

      // 聚合 quality signals
      const qualitySignals = this.aggregateQualitySignals(turnRows);

      const inputTokens = (sessionRow?.total_input_tokens as number) || turns.reduce((sum, t) => sum + t.inputTokens, 0);
      const outputTokens = (sessionRow?.total_output_tokens as number) || turns.reduce((sum, t) => sum + t.outputTokens, 0);
      const estimatedCost = (sessionRow?.estimated_cost as number) || 0;

      const startTime = (sessionRow?.start_time as number) || (turnRows[0]?.start_time as number) || Date.now();
      const endTime = (sessionRow?.end_time as number) || (turnRows[turnRows.length - 1]?.end_time as number) || Date.now();

      return {
        sessionId,
        messages,
        toolCalls,
        turns,
        startTime,
        endTime,
        inputTokens,
        outputTokens,
        totalCost: estimatedCost,
        qualitySignals,
      };
    } catch (error) {
      logger.warn('Failed to collect from telemetry tables', { error });
      return null;
    }
  }

  /**
   * 从 turns 行聚合质量信号
   */
  private aggregateQualitySignals(turnRows: Record<string, unknown>[]): QualitySignals {
    let totalRetries = 0;
    let errorRecoveries = 0;
    let compactionCount = 0;
    let circuitBreakerTrips = 0;

    for (const row of turnRows) {
      const qsStr = row.quality_signals as string | null;
      if (!qsStr) continue;
      try {
        const qs = JSON.parse(qsStr);
        totalRetries += qs.retryCount || 0;
        errorRecoveries += qs.errorRecovered || 0;
        if (qs.compactionTriggered) compactionCount++;
        if (qs.circuitBreakerTripped) circuitBreakerTrips++;
      } catch { /* ignore */ }
    }

    return {
      totalRetries,
      errorRecoveries,
      compactionCount,
      circuitBreakerTrips,
      selfRepairAttempts: 0, // 由 analyzeTranscript 计算
      selfRepairSuccesses: 0,
      verificationActions: 0,
    };
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
   * 保存评测结果
   */
  async saveResult(result: EvaluationResult): Promise<void> {
    const dbInstance = this.getDbInstance();

    // 确保表存在
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        score INTEGER NOT NULL,
        grade TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);

    dbInstance
      .prepare(
        `INSERT INTO evaluations (id, session_id, timestamp, score, grade, data)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.id,
        result.sessionId,
        result.timestamp,
        result.overallScore,
        result.grade,
        JSON.stringify(result)
      );
  }
}
