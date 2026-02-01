// ============================================================================
// Trace Recorder - 执行轨迹记录器
// Gen 8: Self-Evolution - 完整记录执行过程用于学习
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TraceRecorder');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface PlanningStep {
  id: string;
  description: string;
  reasoning?: string;
  timestamp: number;
}

export interface ToolCallWithResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: {
    success: boolean;
    output?: string;
    error?: string;
  };
  durationMs: number;
  timestamp: number;
}

export interface TraceMetrics {
  durationMs: number;
  tokenCost: number;
  toolCallCount: number;
  retryCount: number;
}

export type TraceOutcome = 'success' | 'failure' | 'partial';

export interface ExecutionTrace {
  id: string;
  sessionId: string;
  taskDescription: string;
  planningSteps: PlanningStep[];
  toolCalls: ToolCallWithResult[];
  outcome: TraceOutcome;
  outcomeReason?: string;
  outcomeConfidence?: number;
  userFeedback?: 'positive' | 'negative';
  metrics: TraceMetrics;
  projectPath?: string;
  createdAt: number;
}

// 数据库行类型
type SQLiteRow = Record<string, unknown>;

// ----------------------------------------------------------------------------
// Trace Recorder Service
// ----------------------------------------------------------------------------

export class TraceRecorder {
  private currentTrace: Partial<ExecutionTrace> | null = null;
  private startTime: number = 0;
  private retryCount: number = 0;
  private tokenCost: number = 0;

  /**
   * 在 AgentLoop.run() 开始时调用
   */
  startTrace(sessionId: string, taskDescription: string, projectPath?: string): void {
    this.startTime = Date.now();
    this.retryCount = 0;
    this.tokenCost = 0;

    this.currentTrace = {
      id: `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId,
      taskDescription,
      planningSteps: [],
      toolCalls: [],
      projectPath,
      createdAt: Date.now(),
    };

    logger.debug('[TraceRecorder] Trace started', {
      traceId: this.currentTrace.id,
      sessionId,
    });
  }

  /**
   * 记录规划步骤
   */
  recordPlanningStep(step: PlanningStep): void {
    if (!this.currentTrace) {
      logger.warn('[TraceRecorder] No active trace, ignoring planning step');
      return;
    }

    this.currentTrace.planningSteps = this.currentTrace.planningSteps || [];
    this.currentTrace.planningSteps.push(step);

    logger.debug('[TraceRecorder] Planning step recorded', {
      stepId: step.id,
      description: step.description.substring(0, 100),
    });
  }

  /**
   * 记录工具调用（在 tool_call_end 事件时调用）
   */
  recordToolCall(toolCall: ToolCallWithResult): void {
    if (!this.currentTrace) {
      logger.warn('[TraceRecorder] No active trace, ignoring tool call');
      return;
    }

    this.currentTrace.toolCalls = this.currentTrace.toolCalls || [];
    this.currentTrace.toolCalls.push(toolCall);

    // 更新重试计数
    if (!toolCall.result.success) {
      this.retryCount++;
    }

    logger.debug('[TraceRecorder] Tool call recorded', {
      toolName: toolCall.name,
      success: toolCall.result.success,
      durationMs: toolCall.durationMs,
    });
  }

  /**
   * 记录 token 消耗
   */
  recordTokenUsage(tokens: number): void {
    this.tokenCost += tokens;
  }

  /**
   * 在 AgentLoop 结束时调用
   */
  async endTrace(
    outcome: TraceOutcome,
    outcomeReason?: string,
    outcomeConfidence?: number
  ): Promise<ExecutionTrace | null> {
    if (!this.currentTrace) {
      logger.warn('[TraceRecorder] No active trace to end');
      return null;
    }

    const durationMs = Date.now() - this.startTime;

    const trace: ExecutionTrace = {
      id: this.currentTrace.id!,
      sessionId: this.currentTrace.sessionId!,
      taskDescription: this.currentTrace.taskDescription!,
      planningSteps: this.currentTrace.planningSteps || [],
      toolCalls: this.currentTrace.toolCalls || [],
      outcome,
      outcomeReason,
      outcomeConfidence,
      metrics: {
        durationMs,
        tokenCost: this.tokenCost,
        toolCallCount: (this.currentTrace.toolCalls || []).length,
        retryCount: this.retryCount,
      },
      projectPath: this.currentTrace.projectPath,
      createdAt: this.currentTrace.createdAt!,
    };

    // 持久化到数据库
    await this.persist(trace);

    logger.info('[TraceRecorder] Trace ended', {
      traceId: trace.id,
      outcome,
      durationMs,
      toolCallCount: trace.metrics.toolCallCount,
    });

    // 重置状态
    this.currentTrace = null;
    this.startTime = 0;
    this.retryCount = 0;
    this.tokenCost = 0;

    return trace;
  }

  /**
   * 记录用户反馈
   */
  async recordUserFeedback(traceId: string, feedback: 'positive' | 'negative'): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      logger.error('[TraceRecorder] Database not initialized');
      return;
    }

    try {
      dbInstance.prepare(`
        UPDATE execution_traces SET user_feedback = ? WHERE id = ?
      `).run(feedback, traceId);

      logger.info('[TraceRecorder] User feedback recorded', { traceId, feedback });
    } catch (error) {
      logger.error('[TraceRecorder] Failed to record user feedback:', error);
    }
  }

  /**
   * 获取当前轨迹 ID（用于外部引用）
   */
  getCurrentTraceId(): string | null {
    return this.currentTrace?.id || null;
  }

  /**
   * 检查是否有活动轨迹
   */
  hasActiveTrace(): boolean {
    return this.currentTrace !== null;
  }

  /**
   * 持久化轨迹到数据库
   */
  private async persist(trace: ExecutionTrace): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      logger.error('[TraceRecorder] Database not initialized, trace not persisted');
      return;
    }

    try {
      dbInstance.prepare(`
        INSERT INTO execution_traces (
          id, session_id, task_description, planning_steps, tool_calls,
          outcome, outcome_reason, outcome_confidence, user_feedback,
          metrics, project_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trace.id,
        trace.sessionId,
        trace.taskDescription,
        JSON.stringify(trace.planningSteps),
        JSON.stringify(trace.toolCalls),
        trace.outcome,
        trace.outcomeReason || null,
        trace.outcomeConfidence || null,
        trace.userFeedback || null,
        JSON.stringify(trace.metrics),
        trace.projectPath || null,
        trace.createdAt
      );

      logger.debug('[TraceRecorder] Trace persisted to database', { traceId: trace.id });
    } catch (error) {
      logger.error('[TraceRecorder] Failed to persist trace:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Static Query Methods
  // --------------------------------------------------------------------------

  /**
   * 获取会话的所有轨迹
   */
  static getTracesBySession(sessionId: string): ExecutionTrace[] {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    const rows = dbInstance.prepare(`
      SELECT * FROM execution_traces WHERE session_id = ? ORDER BY created_at DESC
    `).all(sessionId) as SQLiteRow[];

    return rows.map(TraceRecorder.rowToTrace);
  }

  /**
   * 获取成功的轨迹（用于学习）
   */
  static getSuccessfulTraces(
    options: {
      projectPath?: string;
      minConfidence?: number;
      limit?: number;
      since?: number;
    } = {}
  ): ExecutionTrace[] {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    const conditions: string[] = ["outcome = 'success'"];
    const params: unknown[] = [];

    if (options.projectPath) {
      conditions.push('project_path = ?');
      params.push(options.projectPath);
    }

    if (options.minConfidence !== undefined) {
      conditions.push('outcome_confidence >= ?');
      params.push(options.minConfidence);
    }

    if (options.since !== undefined) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }

    const limit = options.limit || 100;
    params.push(limit);

    const sql = `
      SELECT * FROM execution_traces
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `;

    const rows = dbInstance.prepare(sql).all(...params) as SQLiteRow[];
    return rows.map(TraceRecorder.rowToTrace);
  }

  /**
   * 获取带有正向用户反馈的轨迹
   */
  static getPositiveFeedbackTraces(limit: number = 50): ExecutionTrace[] {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    const rows = dbInstance.prepare(`
      SELECT * FROM execution_traces
      WHERE user_feedback = 'positive'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as SQLiteRow[];

    return rows.map(TraceRecorder.rowToTrace);
  }

  /**
   * 获取单个轨迹
   */
  static getTrace(traceId: string): ExecutionTrace | null {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return null;

    const row = dbInstance.prepare(`
      SELECT * FROM execution_traces WHERE id = ?
    `).get(traceId) as SQLiteRow | undefined;

    if (!row) return null;
    return TraceRecorder.rowToTrace(row);
  }

  /**
   * 获取轨迹统计
   */
  static getTraceStats(): {
    total: number;
    successful: number;
    failed: number;
    partial: number;
    avgDuration: number;
    avgToolCalls: number;
  } {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      return { total: 0, successful: 0, failed: 0, partial: 0, avgDuration: 0, avgToolCalls: 0 };
    }

    const stats = dbInstance.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partial
      FROM execution_traces
    `).get() as SQLiteRow;

    // 计算平均值需要解析 metrics JSON
    const allTraces = dbInstance.prepare(`SELECT metrics FROM execution_traces`).all() as SQLiteRow[];
    let totalDuration = 0;
    let totalToolCalls = 0;

    for (const row of allTraces) {
      try {
        const metrics = JSON.parse(row.metrics as string) as TraceMetrics;
        totalDuration += metrics.durationMs;
        totalToolCalls += metrics.toolCallCount;
      } catch {
        // 忽略解析错误
      }
    }

    const total = (stats.total as number) || 0;

    return {
      total,
      successful: (stats.successful as number) || 0,
      failed: (stats.failed as number) || 0,
      partial: (stats.partial as number) || 0,
      avgDuration: total > 0 ? totalDuration / total : 0,
      avgToolCalls: total > 0 ? totalToolCalls / total : 0,
    };
  }

  /**
   * 行数据转 ExecutionTrace
   */
  private static rowToTrace(row: SQLiteRow): ExecutionTrace {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      taskDescription: row.task_description as string,
      planningSteps: JSON.parse((row.planning_steps as string) || '[]'),
      toolCalls: JSON.parse((row.tool_calls as string) || '[]'),
      outcome: row.outcome as TraceOutcome,
      outcomeReason: row.outcome_reason as string | undefined,
      outcomeConfidence: row.outcome_confidence as number | undefined,
      userFeedback: row.user_feedback as 'positive' | 'negative' | undefined,
      metrics: JSON.parse((row.metrics as string) || '{}'),
      projectPath: row.project_path as string | undefined,
      createdAt: row.created_at as number,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let traceRecorderInstance: TraceRecorder | null = null;

export function getTraceRecorder(): TraceRecorder {
  if (!traceRecorderInstance) {
    traceRecorderInstance = new TraceRecorder();
  }
  return traceRecorderInstance;
}

// 导出用于测试
export { TraceRecorder as TraceRecorderClass };
