// ============================================================================
// Session Analytics Service - 会话分析服务
// ============================================================================
// 负责计算客观指标，不依赖 LLM
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type {
  ObjectiveMetrics,
  ToolCallRecord,
  MessageRecord,
  SessionAnalysis,
} from '../../shared/types/sessionAnalytics';

const logger = createLogger('SessionAnalyticsService');

/**
 * 会话分析服务
 */
export class SessionAnalyticsService {
  private static instance: SessionAnalyticsService;

  private constructor() {}

  static getInstance(): SessionAnalyticsService {
    if (!SessionAnalyticsService.instance) {
      SessionAnalyticsService.instance = new SessionAnalyticsService();
    }
    return SessionAnalyticsService.instance;
  }

  /**
   * 获取数据库实例
   */
  private getDb() {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      throw new Error('Database not initialized');
    }
    return dbInstance;
  }

  /**
   * 计算会话的客观指标
   */
  async calculateObjectiveMetrics(sessionId: string): Promise<ObjectiveMetrics> {
    logger.info(`Calculating objective metrics for session: ${sessionId}`);

    const db = this.getDb();

    // 获取消息
    const messages = this.getMessages(db, sessionId);

    // 获取工具调用
    const toolCalls = this.getToolCalls(db, sessionId);

    // 获取会话信息
    const session = this.getSessionInfo(db, sessionId);

    // 计算时间范围
    const startTime = messages[0]?.timestamp || session?.created_at || Date.now();
    const endTime = messages[messages.length - 1]?.timestamp || session?.updated_at || Date.now();
    const duration = endTime - startTime;

    // 消息统计
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    const avgUserMessageLength = userMessages.length > 0
      ? Math.round(userMessages.reduce((acc, m) => acc + m.contentLength, 0) / userMessages.length)
      : 0;

    const avgAssistantMessageLength = assistantMessages.length > 0
      ? Math.round(assistantMessages.reduce((acc, m) => acc + m.contentLength, 0) / assistantMessages.length)
      : 0;

    // 工具调用统计
    const successfulToolCalls = toolCalls.filter(t => t.success).length;
    const failedToolCalls = toolCalls.filter(t => !t.success).length;
    const toolSuccessRate = toolCalls.length > 0
      ? Math.round((successfulToolCalls / toolCalls.length) * 100)
      : 100;

    const toolCallsByName: Record<string, number> = {};
    for (const tc of toolCalls) {
      toolCallsByName[tc.name] = (toolCallsByName[tc.name] || 0) + 1;
    }

    const avgToolLatency = toolCalls.length > 0
      ? Math.round(toolCalls.reduce((acc, t) => acc + t.duration, 0) / toolCalls.length)
      : 0;

    // Token 统计
    const totalInputTokens = toolCalls.reduce((acc, t) => acc + (t.inputTokens || 0), 0);
    const totalOutputTokens = toolCalls.reduce((acc, t) => acc + (t.outputTokens || 0), 0);
    const totalTokens = totalInputTokens + totalOutputTokens;

    // 估算成本 (按 GPT-4 价格粗略估算)
    const estimatedCost = (totalInputTokens * 0.00003 + totalOutputTokens * 0.00006);

    // 代码统计
    const messagesWithCode = messages.filter(m => m.hasCode).length;
    const codeBlocksGenerated = messages.reduce((acc, m) => acc + m.codeBlocks, 0);

    // 交互模式
    const turnsCount = Math.min(userMessages.length, assistantMessages.length);

    // 计算平均响应时间
    let avgResponseTime = 0;
    if (userMessages.length > 0 && assistantMessages.length > 0) {
      const responseTimes: number[] = [];
      for (let i = 0; i < userMessages.length && i < assistantMessages.length; i++) {
        const userMsg = userMessages[i];
        const assistantMsg = assistantMessages.find(
          m => m.timestamp > userMsg.timestamp
        );
        if (assistantMsg) {
          responseTimes.push(assistantMsg.timestamp - userMsg.timestamp);
        }
      }
      if (responseTimes.length > 0) {
        avgResponseTime = Math.round(
          responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        );
      }
    }

    const metrics: ObjectiveMetrics = {
      sessionId,
      startTime,
      endTime,
      duration,

      totalMessages: messages.length,
      userMessages: userMessages.length,
      assistantMessages: assistantMessages.length,
      avgUserMessageLength,
      avgAssistantMessageLength,

      totalToolCalls: toolCalls.length,
      successfulToolCalls,
      failedToolCalls,
      toolSuccessRate,
      toolCallsByName,
      avgToolLatency,

      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCost,

      codeBlocksGenerated,
      messagesWithCode,

      turnsCount,
      avgResponseTime,
    };

    logger.info('Objective metrics calculated', {
      sessionId,
      messages: metrics.totalMessages,
      toolCalls: metrics.totalToolCalls,
      duration: metrics.duration,
    });

    return metrics;
  }

  /**
   * 获取消息记录
   */
  private getMessages(db: ReturnType<typeof this.getDb>, sessionId: string): MessageRecord[] {
    const rows = db
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

    return rows.map(row => {
      const content = row.content || '';
      const codeBlockMatches = content.match(/```[\s\S]*?```/g) || [];

      return {
        id: row.id,
        role: row.role as 'user' | 'assistant' | 'system',
        contentLength: content.length,
        timestamp: row.timestamp,
        hasCode: codeBlockMatches.length > 0,
        codeBlocks: codeBlockMatches.length,
      };
    });
  }

  /**
   * 获取工具调用记录
   */
  private getToolCalls(db: ReturnType<typeof this.getDb>, sessionId: string): ToolCallRecord[] {
    try {
      // 检查 tool_uses 表是否存在
      const tableExists = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='tool_uses'`
        )
        .get();

      if (!tableExists) {
        return [];
      }

      const rows = db
        .prepare(
          `SELECT id, tool_name, success, duration_ms, timestamp,
                  input_tokens, output_tokens
           FROM tool_uses
           WHERE session_id = ?
           ORDER BY timestamp ASC`
        )
        .all(sessionId) as {
          id: string;
          tool_name: string;
          success: number;
          duration_ms: number;
          timestamp: number;
          input_tokens?: number;
          output_tokens?: number;
        }[];

      return rows.map(row => ({
        id: row.id,
        name: row.tool_name,
        success: row.success === 1,
        duration: row.duration_ms || 0,
        timestamp: row.timestamp,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取会话信息
   */
  private getSessionInfo(
    db: ReturnType<typeof this.getDb>,
    sessionId: string
  ): { created_at: number; updated_at: number } | null {
    const row = db
      .prepare(`SELECT created_at, updated_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { created_at: number; updated_at: number } | undefined;

    return row || null;
  }

  /**
   * 获取历史评测记录
   */
  async getHistoricalEvaluations(
    sessionId: string,
    limit = 5
  ): Promise<{ id: string; timestamp: number; overallScore: number; grade: string }[]> {
    const db = this.getDb();

    try {
      // 检查 evaluations 表是否存在
      const tableExists = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'`
        )
        .get();

      if (!tableExists) {
        return [];
      }

      const rows = db
        .prepare(
          `SELECT id, timestamp, score, grade
           FROM evaluations
           WHERE session_id = ?
           ORDER BY timestamp DESC
           LIMIT ?`
        )
        .all(sessionId, limit) as {
          id: string;
          timestamp: number;
          score: number;
          grade: string;
        }[];

      return rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        overallScore: row.score,
        grade: row.grade,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取最新的评测结果
   */
  async getLatestEvaluation(sessionId: string): Promise<SessionAnalysis | null> {
    const db = this.getDb();

    try {
      const tableExists = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'`
        )
        .get();

      if (!tableExists) {
        return null;
      }

      const row = db
        .prepare(
          `SELECT id, data
           FROM evaluations
           WHERE session_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`
        )
        .get(sessionId) as { id: string; data: string } | undefined;

      if (!row) {
        return null;
      }

      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  /**
   * 获取会话的完整分析数据（客观指标 + 历史评测）
   */
  async getSessionAnalysis(sessionId: string): Promise<{
    objective: ObjectiveMetrics;
    previousEvaluations: { id: string; timestamp: number; overallScore: number; grade: string }[];
    latestEvaluation: SessionAnalysis | null;
  }> {
    const [objective, previousEvaluations, latestEvaluation] = await Promise.all([
      this.calculateObjectiveMetrics(sessionId),
      this.getHistoricalEvaluations(sessionId),
      this.getLatestEvaluation(sessionId),
    ]);

    return {
      objective,
      previousEvaluations,
      latestEvaluation,
    };
  }
}

// Singleton export
let analyticsServiceInstance: SessionAnalyticsService | null = null;

export function getSessionAnalyticsService(): SessionAnalyticsService {
  if (!analyticsServiceInstance) {
    analyticsServiceInstance = SessionAnalyticsService.getInstance();
  }
  return analyticsServiceInstance;
}
