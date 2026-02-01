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
import type { SessionSnapshot, DimensionEvaluator } from './types';
import {
  TaskCompletionEvaluator,
  ToolEfficiencyEvaluator,
  DialogQualityEvaluator,
  CodeQualityEvaluator,
  PerformanceEvaluator,
  SecurityEvaluator,
} from './metrics';
import { getAIEvaluator } from './aiEvaluator';

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
   * 优先使用 AI 深度评测，失败时回退到规则评测
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
      // 尝试 AI 深度评测
      try {
        logger.info('Attempting AI-powered evaluation...');
        const aiEvaluator = getAIEvaluator();
        const aiResult = await aiEvaluator.evaluate(snapshot);

        if (aiResult) {
          // AI 评测成功
          metrics = aiEvaluator.convertToMetrics(aiResult);
          overallScore = aiResult.overallScore;
          allSuggestions = aiResult.suggestions || [];
          aiSummary = aiResult.summary;
          logger.info('AI evaluation succeeded', { overallScore });
        } else {
          throw new Error('AI evaluation returned null');
        }
      } catch (aiError) {
        // AI 评测失败，回退到规则评测
        logger.warn('AI evaluation failed, falling back to rule-based', { error: aiError });
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
   * 收集会话数据
   */
  private async collectSessionData(sessionId: string): Promise<SessionSnapshot> {
    const dbInstance = this.getDbInstance();

    // 获取消息
    const messageRows = dbInstance
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

    // 获取工具调用（从 tool_uses 表，如果存在）
    let toolCalls: {
      id: string;
      name: string;
      args: Record<string, unknown>;
      result?: string;
      success: boolean;
      duration: number;
      timestamp: number;
    }[] = [];

    try {
      // 检查 tool_uses 表是否存在
      const tableExists = dbInstance
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='tool_uses'`
        )
        .get();

      if (tableExists) {
        const toolUseRows = dbInstance
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
      // 表不存在或查询失败，使用空数组
    }

    // 获取会话统计
    const sessionRow = dbInstance
      .prepare(
        `SELECT created_at, updated_at
         FROM sessions WHERE id = ?`
      )
      .get(sessionId) as {
      created_at: number;
      updated_at: number;
    } | undefined;

    const startTime = messages[0]?.timestamp || sessionRow?.created_at || Date.now();
    const endTime =
      messages[messages.length - 1]?.timestamp ||
      sessionRow?.updated_at ||
      Date.now();

    return {
      sessionId,
      messages,
      toolCalls,
      startTime,
      endTime,
      inputTokens: 0,  // Token 统计在当前数据库 schema 中不可用
      outputTokens: 0,
      totalCost: 0,
    };
  }

  /**
   * 保存评测结果
   */
  private async saveResult(result: EvaluationResult): Promise<void> {
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
