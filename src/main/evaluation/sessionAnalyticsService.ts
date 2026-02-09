// ============================================================================
// Session Analytics Service - 会话分析服务
// ============================================================================
// 负责计算客观指标，不依赖 LLM
// 优先从遥测表获取丰富数据，fallback 到 messages/tool_uses 表
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type {
  ObjectiveMetrics,
  ToolCallRecord,
  MessageRecord,
  SessionAnalysis,
} from '../../shared/types/sessionAnalytics';
import { getSessionEventService } from './sessionEventService';

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
   * 计算会话的客观指标 — 优先使用遥测数据
   */
  async calculateObjectiveMetrics(sessionId: string): Promise<ObjectiveMetrics> {
    logger.info(`Calculating objective metrics for session: ${sessionId}`);

    const db = this.getDb();

    // 尝试从遥测表获取增强指标
    const telemetryMetrics = this.calculateFromTelemetry(db, sessionId);
    if (telemetryMetrics) {
      logger.info('Objective metrics calculated from telemetry', {
        sessionId,
        turns: telemetryMetrics.turnsCount,
        tokens: telemetryMetrics.totalTokens,
      });
      return telemetryMetrics;
    }

    // Fallback: 从旧表获取
    logger.info('Falling back to legacy tables for objective metrics', { sessionId });
    return this.calculateFromLegacyTables(db, sessionId);
  }

  /**
   * 从遥测表计算增强客观指标
   */
  private calculateFromTelemetry(
    db: ReturnType<typeof this.getDb>,
    sessionId: string
  ): ObjectiveMetrics | null {
    try {
      // 检查 telemetry_turns 是否有数据
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_turns'`)
        .get();
      if (!tableExists) return null;

      const turnCount = db
        .prepare(`SELECT COUNT(*) as cnt FROM telemetry_turns WHERE session_id = ?`)
        .get(sessionId) as { cnt: number };
      if (!turnCount || turnCount.cnt === 0) return null;

      // 获取 session 级聚合
      const sessionRow = db
        .prepare(`SELECT * FROM telemetry_sessions WHERE id = ?`)
        .get(sessionId) as Record<string, unknown> | undefined;

      // 获取 turns
      const turnRows = db
        .prepare(`SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY turn_number ASC`)
        .all(sessionId) as Record<string, unknown>[];

      // 获取 tool_calls
      const toolCallRows = db
        .prepare(`SELECT * FROM telemetry_tool_calls WHERE session_id = ? ORDER BY timestamp ASC`)
        .all(sessionId) as Record<string, unknown>[];

      // 基础统计
      const startTime = (sessionRow?.start_time as number) || (turnRows[0]?.start_time as number) || Date.now();
      const endTime = (sessionRow?.end_time as number) || (turnRows[turnRows.length - 1]?.end_time as number) || Date.now();
      const duration = endTime - startTime;

      // 消息统计
      const userMessages = turnRows.length;
      const assistantMessages = turnRows.filter(t => (t.assistant_response as string)?.length > 0).length;
      const totalMessages = userMessages + assistantMessages;

      const avgUserMessageLength = userMessages > 0
        ? Math.round(turnRows.reduce((acc, t) => acc + ((t.user_prompt as string) || '').length, 0) / userMessages)
        : 0;
      const avgAssistantMessageLength = assistantMessages > 0
        ? Math.round(turnRows.reduce((acc, t) => acc + ((t.assistant_response as string) || '').length, 0) / assistantMessages)
        : 0;

      // 工具调用统计
      const totalToolCalls = toolCallRows.length;
      const successfulToolCalls = toolCallRows.filter(tc => (tc.success as number) === 1).length;
      const failedToolCalls = totalToolCalls - successfulToolCalls;
      const toolSuccessRate = totalToolCalls > 0 ? Math.round((successfulToolCalls / totalToolCalls) * 100) : 100;

      const toolCallsByName: Record<string, number> = {};
      for (const tc of toolCallRows) {
        const name = tc.name as string;
        toolCallsByName[name] = (toolCallsByName[name] || 0) + 1;
      }

      const avgToolLatency = totalToolCalls > 0
        ? Math.round(toolCallRows.reduce((acc, t) => acc + ((t.duration_ms as number) || 0), 0) / totalToolCalls)
        : 0;

      // Token 统计（从遥测 session 聚合或 turns 累加）
      const totalInputTokens = (sessionRow?.total_input_tokens as number) || turnRows.reduce((acc, t) => acc + ((t.total_input_tokens as number) || 0), 0);
      const totalOutputTokens = (sessionRow?.total_output_tokens as number) || turnRows.reduce((acc, t) => acc + ((t.total_output_tokens as number) || 0), 0);
      const totalTokens = totalInputTokens + totalOutputTokens;
      const estimatedCost = (sessionRow?.estimated_cost as number) || 0;

      // 代码统计
      let codeBlocksGenerated = 0;
      let messagesWithCode = 0;
      for (const t of turnRows) {
        const response = (t.assistant_response as string) || '';
        const blocks = (response.match(/```[\s\S]*?```/g) || []).length;
        codeBlocksGenerated += blocks;
        if (blocks > 0) messagesWithCode++;
      }

      // 平均响应时间
      const avgResponseTime = turnRows.length > 0
        ? Math.round(turnRows.reduce((acc, t) => acc + ((t.duration_ms as number) || 0), 0) / turnRows.length)
        : 0;

      // v3 新增：意图分布
      const intentDistribution: Record<string, number> = {};
      for (const t of turnRows) {
        const intent = (t.intent_primary as string) || 'unknown';
        intentDistribution[intent] = (intentDistribution[intent] || 0) + 1;
      }

      // v3 新增：错误分类
      const errorTaxonomy = this.buildErrorTaxonomy(toolCallRows);

      // v3 新增：self-repair 率
      const selfRepairRate = this.calculateSelfRepairRate(turnRows, toolCallRows);

      // v3 新增：每轮 Token 消耗
      const tokenPerTurn = turnRows.map(t =>
        ((t.total_input_tokens as number) || 0) + ((t.total_output_tokens as number) || 0)
      );

      return {
        sessionId,
        startTime,
        endTime,
        duration,
        totalMessages,
        userMessages,
        assistantMessages,
        avgUserMessageLength,
        avgAssistantMessageLength,
        totalToolCalls,
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
        turnsCount: turnRows.length,
        avgResponseTime,
        intentDistribution,
        errorTaxonomy,
        selfRepairRate,
        tokenPerTurn,
      };
    } catch (error) {
      logger.warn('Failed to calculate metrics from telemetry', { error });
      return null;
    }
  }

  /**
   * 构建错误分类统计
   */
  private buildErrorTaxonomy(toolCallRows: Record<string, unknown>[]): Record<string, number> {
    const taxonomy: Record<string, number> = {};
    for (const tc of toolCallRows) {
      if ((tc.success as number) === 1) continue;
      const errorStr = (tc.error as string) || '';
      const category = this.classifyError(errorStr, tc.name as string);
      taxonomy[category] = (taxonomy[category] || 0) + 1;
    }
    return taxonomy;
  }

  /**
   * 错误分类（12 类）
   */
  private classifyError(error: string, toolName: string): string {
    const lower = error.toLowerCase();
    if (lower.includes('not found') || lower.includes('no such file')) return 'file_not_found';
    if (lower.includes('permission') || lower.includes('access denied')) return 'permission_denied';
    if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
    if (lower.includes('syntax') || lower.includes('parse error')) return 'syntax_error';
    if (lower.includes('unique') || lower.includes('not unique')) return 'edit_not_unique';
    if (lower.includes('hallucin') || lower.includes('does not exist')) return 'path_hallucination';
    if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
    if (lower.includes('connection') || lower.includes('network')) return 'network_error';
    if (toolName === 'edit_file') return 'edit_failure';
    if (toolName === 'bash') return 'command_failure';
    if (lower.includes('retry') || lower.includes('again')) return 'infinite_retry';
    return 'other';
  }

  /**
   * 计算 self-repair 成功率
   */
  private calculateSelfRepairRate(
    _turnRows: Record<string, unknown>[],
    toolCallRows: Record<string, unknown>[]
  ): number {
    // self-repair: 工具失败后，同 turn 内同工具重试并成功
    let repairAttempts = 0;
    let repairSuccesses = 0;

    // 按 turn 分组
    const byTurn: Record<string, Record<string, unknown>[]> = {};
    for (const tc of toolCallRows) {
      const turnId = tc.turn_id as string;
      if (!byTurn[turnId]) byTurn[turnId] = [];
      byTurn[turnId].push(tc);
    }

    for (const turnToolCalls of Object.values(byTurn)) {
      for (let i = 0; i < turnToolCalls.length; i++) {
        const tc = turnToolCalls[i];
        if ((tc.success as number) === 1) continue;

        // 查找后续同名工具调用
        const toolName = tc.name as string;
        for (let j = i + 1; j < turnToolCalls.length; j++) {
          if ((turnToolCalls[j].name as string) === toolName) {
            repairAttempts++;
            if ((turnToolCalls[j].success as number) === 1) {
              repairSuccesses++;
            }
            break;
          }
        }
      }
    }

    return repairAttempts > 0 ? Math.round((repairSuccesses / repairAttempts) * 100) : 100;
  }

  /**
   * Fallback: 从旧表计算指标
   */
  private calculateFromLegacyTables(
    db: ReturnType<typeof this.getDb>,
    sessionId: string
  ): ObjectiveMetrics {
    const messages = this.getMessages(db, sessionId);
    const toolCalls = this.getToolCalls(db, sessionId);
    const session = this.getSessionTimestamps(db, sessionId);

    const startTime = messages[0]?.timestamp || session?.created_at || Date.now();
    const endTime = messages[messages.length - 1]?.timestamp || session?.updated_at || Date.now();
    const duration = endTime - startTime;

    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    const avgUserMessageLength = userMessages.length > 0
      ? Math.round(userMessages.reduce((acc, m) => acc + m.contentLength, 0) / userMessages.length)
      : 0;

    const avgAssistantMessageLength = assistantMessages.length > 0
      ? Math.round(assistantMessages.reduce((acc, m) => acc + m.contentLength, 0) / assistantMessages.length)
      : 0;

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

    const totalInputTokens = toolCalls.reduce((acc, t) => acc + (t.inputTokens || 0), 0);
    const totalOutputTokens = toolCalls.reduce((acc, t) => acc + (t.outputTokens || 0), 0);
    const totalTokens = totalInputTokens + totalOutputTokens;
    const estimatedCost = (totalInputTokens * 0.00003 + totalOutputTokens * 0.00006);

    const messagesWithCode = messages.filter(m => m.hasCode).length;
    const codeBlocksGenerated = messages.reduce((acc, m) => acc + m.codeBlocks, 0);
    const turnsCount = Math.min(userMessages.length, assistantMessages.length);

    let avgResponseTime = 0;
    if (userMessages.length > 0 && assistantMessages.length > 0) {
      const responseTimes: number[] = [];
      for (let i = 0; i < userMessages.length && i < assistantMessages.length; i++) {
        const userMsg = userMessages[i];
        const assistantMsg = assistantMessages.find(m => m.timestamp > userMsg.timestamp);
        if (assistantMsg) {
          responseTimes.push(assistantMsg.timestamp - userMsg.timestamp);
        }
      }
      if (responseTimes.length > 0) {
        avgResponseTime = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
      }
    }

    return {
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
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tool_uses'`)
        .get();

      if (!tableExists) return [];

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
   * 获取会话时间信息（用于客观指标计算）
   */
  private getSessionTimestamps(
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
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'`)
        .get();

      if (!tableExists) return [];

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
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'`)
        .get();

      if (!tableExists) return null;

      const row = db
        .prepare(
          `SELECT id, data
           FROM evaluations
           WHERE session_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`
        )
        .get(sessionId) as { id: string; data: string } | undefined;

      if (!row) return null;

      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  /**
   * 获取会话基本信息（用于评测中心头部展示）
   */
  getSessionInfo(sessionId: string): {
    title: string;
    modelProvider: string;
    modelName: string;
    startTime: number;
    endTime?: number;
    generationId: string;
    workingDirectory: string;
    status: string;
    turnCount: number;
    totalTokens: number;
    estimatedCost: number;
  } | null {
    const db = this.getDb();

    // 优先从 telemetry_sessions 获取
    try {
      const row = db
        .prepare(`SELECT * FROM telemetry_sessions WHERE id = ?`)
        .get(sessionId) as Record<string, unknown> | undefined;

      if (row) {
        let title = (row.title as string) || '未命名会话';

        // telemetry_sessions.title 通常存的是 workingDirectory，
        // 尝试从 sessions 表获取 AI 生成的智能标题
        if (title.startsWith('/') || title === '未命名会话') {
          try {
            const sessionRow = db
              .prepare(`SELECT title FROM sessions WHERE id = ?`)
              .get(sessionId) as { title?: string } | undefined;
            if (sessionRow?.title && !sessionRow.title.startsWith('/')) {
              title = sessionRow.title;
            }
          } catch { /* sessions table might not exist */ }
        }

        return {
          title,
          modelProvider: row.model_provider as string,
          modelName: row.model_name as string,
          startTime: row.start_time as number,
          endTime: row.end_time as number | undefined,
          generationId: (row.generation_id as string) || '',
          workingDirectory: (row.working_directory as string) || '',
          status: (row.status as string) || 'completed',
          turnCount: (row.turn_count as number) || 0,
          totalTokens: (row.total_tokens as number) || 0,
          estimatedCost: (row.estimated_cost as number) || 0,
        };
      }
    } catch {
      // telemetry table might not exist
    }

    // Fallback to sessions table
    try {
      const row = db
        .prepare(`SELECT * FROM sessions WHERE id = ?`)
        .get(sessionId) as Record<string, unknown> | undefined;

      if (row) {
        return {
          title: (row.title as string) || '未命名会话',
          modelProvider: (row.model_provider as string) || '',
          modelName: (row.model_name as string) || '',
          startTime: (row.created_at as number) || Date.now(),
          endTime: row.updated_at as number | undefined,
          generationId: (row.generation_id as string) || '',
          workingDirectory: (row.working_directory as string) || '',
          status: 'completed',
          turnCount: 0,
          totalTokens: 0,
          estimatedCost: 0,
        };
      }
    } catch {
      // sessions table might not exist
    }

    return null;
  }

  /**
   * 获取会话的完整分析数据（客观指标 + 历史评测 + SSE事件摘要 + 会话信息）
   */
  async getSessionAnalysis(sessionId: string): Promise<{
    sessionInfo: ReturnType<SessionAnalyticsService['getSessionInfo']>;
    objective: ObjectiveMetrics;
    previousEvaluations: { id: string; timestamp: number; overallScore: number; grade: string }[];
    latestEvaluation: SessionAnalysis | null;
    eventSummary: {
      eventStats: Record<string, number>;
      toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
      thinkingContent: string[];
      errorEvents: Array<{ type: string; message: string }>;
      timeline: Array<{ time: number; type: string; summary: string }>;
    } | null;
  }> {
    const sessionInfo = this.getSessionInfo(sessionId);
    const [objective, previousEvaluations, latestEvaluation] = await Promise.all([
      this.calculateObjectiveMetrics(sessionId),
      this.getHistoricalEvaluations(sessionId),
      this.getLatestEvaluation(sessionId),
    ]);

    // 获取 SSE 事件摘要
    let eventSummary = null;
    try {
      const eventService = getSessionEventService();
      eventSummary = eventService.buildEventSummaryForEvaluation(sessionId);
    } catch {
      // 事件服务可能未初始化，静默失败
    }

    return {
      sessionInfo,
      objective,
      previousEvaluations,
      latestEvaluation,
      eventSummary,
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
