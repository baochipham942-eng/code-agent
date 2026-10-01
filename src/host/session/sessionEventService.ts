// ============================================================================
// Session Event Service - 会话事件存储服务
// ============================================================================
// 存储完整的 SSE 事件流，用于评测分析
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { getServiceRegistry } from '../services/serviceRegistry';
import { STABLE_EVENT_TYPES, type AgentEvent } from '../../shared/contract';
import type Database from 'better-sqlite3';
import { getActiveRunTraceContext } from '../telemetry/runTraceContext';

const logger = createLogger('SessionEventService');

/** Recent messages with no session event inside this window count as stalled. */
const SESSION_EVENT_STALL_THRESHOLD_MINUTES = 30;
const SESSION_EVENT_LIVENESS_INTERVAL_MS = 10 * 60 * 1000;

interface SessionEventLiveness {
  stalled: boolean;
  lastMessageAt: number | null;
  lastEventAt: number | null;
  minutesSinceLastEvent: number | null;
}

interface SaveFailureDetail {
  message: string;
  stack?: string;
  cause: string;
}

function describeFailure(error: unknown): SaveFailureDetail {
  if (!(error instanceof Error)) {
    const message = String(error);
    return { message, cause: message };
  }
  const nested = error.cause;
  let cause = error.message;
  if (nested instanceof Error) cause = nested.message;
  else if (typeof nested === 'string') cause = nested;
  else if (nested !== undefined) cause = String(nested);
  return {
    message: error.message,
    stack: error.stack,
    cause,
  };
}

function readSqlNumber(row: unknown, key: string): number | null {
  if (!row || typeof row !== 'object') return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStoredEventData(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * 存储的事件记录
 */
export interface StoredEvent {
  id: number;
  sessionId: string;
  eventType: string;
  eventData: unknown;
  timestamp: number;
}

/**
 * 会话事件服务
 */
export class SessionEventService {
  private static instance: SessionEventService;
  private insertStmt: Database.Statement | null = null;
  private saveFailureCount = 0;
  private lastSaveErrorMessage: string | null = null;

  private constructor() {}

  static getInstance(): SessionEventService {
    if (!SessionEventService.instance) {
      SessionEventService.instance = new SessionEventService();
      getServiceRegistry().register('SessionEventService', SessionEventService.instance);
    }
    return SessionEventService.instance;
  }

  /**
   * 获取数据库实例
   */
  private getDb(): Database.Database {
    const db = getDatabase();
    if (!db.isReady) {
      throw new Error('Database not initialized');
    }
    const sqlite = db.getDb();
    if (!sqlite) {
      throw new Error('Database not initialized');
    }
    return sqlite;
  }

  /**
   * 保存事件到数据库
   */
  saveEvent(sessionId: string, event: AgentEvent): void {
    try {
      const db = this.getDb();

      // 准备语句（只创建一次）
      if (!this.insertStmt) {
        this.insertStmt = db.prepare(`
          INSERT INTO session_events (session_id, event_type, event_data, timestamp)
          VALUES (?, ?, ?, ?)
        `);
      }

      // 序列化事件数据
      const activeRunTrace = getActiveRunTraceContext();
      const correlation = activeRunTrace
        ? {
            traceId: activeRunTrace.traceId,
            spanId: activeRunTrace.spanId,
            runId: activeRunTrace.runId,
            attempt: activeRunTrace.attempt,
            ownerEpoch: activeRunTrace.ownerEpoch,
          }
        : undefined;
      const rawData = event.data;
      const correlatedData = correlation
        ? rawData && typeof rawData === 'object' && !Array.isArray(rawData)
          ? { ...(rawData as Record<string, unknown>), _runTrace: correlation }
          : rawData
        : rawData;
      const eventData = correlatedData !== undefined && correlatedData !== null
        ? JSON.stringify(correlatedData)
        : null;

      const insertStmt = this.insertStmt;
      insertStmt.run(
        sessionId,
        event.type,
        eventData,
        Date.now()
      );
    } catch (error) {
      // 失败留痕但不打断主流程。首条以及每 100 条打一条 warn，避免坏库刷屏。
      this.recordSaveFailure(sessionId, event.type, error);
    }
  }

  /** How many saveEvent calls have failed in this process, and the latest cause. */
  getSaveFailureStatus(): { failureCount: number; lastErrorMessage: string | null } {
    return {
      failureCount: this.saveFailureCount,
      lastErrorMessage: this.lastSaveErrorMessage,
    };
  }

  private recordSaveFailure(sessionId: string, eventType: string, error: unknown): void {
    try {
      this.saveFailureCount += 1;
      const detail = describeFailure(error);
      this.lastSaveErrorMessage = detail.message;
      // 第 1 次，以及第 100、200、300… 次。250 次失败因此是 3 条日志。
      if (this.saveFailureCount !== 1 && this.saveFailureCount % 100 !== 0) return;
      logger.warn('Failed to save event', {
        sessionId,
        eventType,
        error: detail.message,
        stack: detail.stack,
        cause: detail.cause,
      });
    } catch {
      // 记账或打日志失败也不能打断主流程。
    }
  }

  /**
   * stalled = a message landed within the last N minutes AND (no event ever, or the
   * latest event is older than N minutes). A message exactly N minutes old is still
   * recent; an event exactly N minutes old is not yet older than N.
   */
  probeSessionEventLiveness(
    sqlite: Database.Database,
    now: number,
    thresholdMinutes = SESSION_EVENT_STALL_THRESHOLD_MINUTES,
  ): SessionEventLiveness {
    const messageRow: unknown = sqlite.prepare(
      'SELECT MAX(timestamp) AS lastMessageAt FROM messages',
    ).get();
    const eventRow: unknown = sqlite.prepare(
      'SELECT timestamp AS lastEventAt FROM session_events ORDER BY id DESC LIMIT 1',
    ).get();
    const lastMessageAt = readSqlNumber(messageRow, 'lastMessageAt');
    const lastEventAt = readSqlNumber(eventRow, 'lastEventAt');
    const thresholdMs = thresholdMinutes * 60 * 1000;
    const messageIsRecent = lastMessageAt !== null && now - lastMessageAt <= thresholdMs;
    const eventIsMissingOrOlder = lastEventAt === null || now - lastEventAt > thresholdMs;
    const stalled = messageIsRecent && eventIsMissingOrOlder;
    const minutesSinceLastEvent = lastEventAt === null ? null : (now - lastEventAt) / 60_000;
    const report: SessionEventLiveness = {
      stalled,
      lastMessageAt,
      lastEventAt,
      minutesSinceLastEvent,
    };
    if (stalled) {
      const failures = this.getSaveFailureStatus();
      logger.warn(
        `messages are being written but no session event has been written for ${thresholdMinutes} minutes`,
        {
          ...report,
          thresholdMinutes,
          failureCount: failures.failureCount,
          lastErrorMessage: failures.lastErrorMessage,
        },
      );
    }
    return report;
  }

  /**
   * 批量保存事件
   */
  saveEvents(sessionId: string, events: AgentEvent[]): void {
    const db = this.getDb();

    const insertMany = db.transaction((evts: AgentEvent[]) => {
      for (const event of evts) {
        this.saveEvent(sessionId, event);
      }
    });

    insertMany(events);
  }

  /**
   * 获取会话的所有事件
   */
  getSessionEvents(sessionId: string): StoredEvent[] {
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT id, session_id, event_type, event_data, timestamp
      FROM session_events
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(sessionId) as {
      id: number;
      session_id: string;
      event_type: string;
      event_data: string | null;
      timestamp: number;
    }[];

    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      eventData: parseStoredEventData(row.event_data),
      timestamp: row.timestamp,
    }));
  }

  /**
   * 获取特定类型的事件
   */
  getEventsByType(sessionId: string, eventType: string): StoredEvent[] {
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT id, session_id, event_type, event_data, timestamp
      FROM session_events
      WHERE session_id = ? AND event_type = ?
      ORDER BY timestamp ASC
    `).all(sessionId, eventType) as {
      id: number;
      session_id: string;
      event_type: string;
      event_data: string | null;
      timestamp: number;
    }[];

    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      eventData: parseStoredEventData(row.event_data),
      timestamp: row.timestamp,
    }));
  }

  /**
   * 获取事件统计
   */
  getEventStats(sessionId: string): Record<string, number> {
    const db = this.getDb();

    const rows = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM session_events
      WHERE session_id = ?
      GROUP BY event_type
    `).all(sessionId) as { event_type: string; count: number }[];

    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.event_type] = row.count;
    }
    return stats;
  }

  /**
   * 构建评测用的事件摘要
   */
  buildEventSummaryForEvaluation(sessionId: string): {
    eventStats: Record<string, number>;
    toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
    thinkingContent: string[];
    errorEvents: Array<{ type: string; message: string }>;
    timeline: Array<{ time: number; type: string; summary: string }>;
  } {
    const events = this.getSessionEvents(sessionId);

    const eventStats: Record<string, number> = {};
    const toolCalls: Array<{ name: string; success: boolean; duration?: number }> = [];
    const thinkingContent: string[] = [];
    const errorEvents: Array<{ type: string; message: string }> = [];
    const timeline: Array<{ time: number; type: string; summary: string }> = [];

    for (const event of events) {
      // Eval summaries consume the stable public contract by default. Keep the two
      // pre-contract aliases readable for historical rows already on disk.
      if (
        event.eventType !== 'tool_start'
        && event.eventType !== 'tool_result'
        && !STABLE_EVENT_TYPES.has(event.eventType as AgentEvent['type'])
      ) {
        continue;
      }
      // 统计事件类型
      eventStats[event.eventType] = (eventStats[event.eventType] || 0) + 1;

      // 提取工具调用
      if (event.eventType === 'tool_call_start' || event.eventType === 'tool_start' || event.eventType === 'tool_call_end' || event.eventType === 'tool_result') {
        const data = event.eventData as Record<string, unknown>;
        if (data?.tool || data?.name) {
          const toolName = (data.tool || data.name) as string;
          const existing = toolCalls.find(t => t.name === toolName);
          if (!existing && (event.eventType === 'tool_call_start' || event.eventType === 'tool_start')) {
            toolCalls.push({
              name: toolName,
              success: true, // 默认成功，后续更新
            });
          }
          if ((event.eventType === 'tool_call_end' || event.eventType === 'tool_result') && data.error) {
            const tool = toolCalls.find(t => t.name === toolName);
            if (tool) tool.success = false;
          }
        }
      }

      // 提取思考内容
      if (event.eventType === 'thinking' || event.eventType === 'reasoning') {
        const data = event.eventData as Record<string, unknown>;
        if (data?.content) {
          thinkingContent.push(String(data.content).slice(0, 500));
        }
      }

      // 提取错误
      if (event.eventType === 'error') {
        const data = event.eventData as Record<string, unknown>;
        errorEvents.push({
          type: 'error',
          message: String(data?.message || data?.error || 'Unknown error'),
        });
      }

      // 构建时间线
      timeline.push({
        time: event.timestamp,
        type: event.eventType,
        summary: this.summarizeEvent(event),
      });
    }

    return {
      eventStats,
      toolCalls,
      thinkingContent: thinkingContent.slice(0, 10), // 最多 10 条
      errorEvents,
      timeline: timeline.slice(-50), // 最近 50 条
    };
  }

  /**
   * 摘要单个事件
   */
  private summarizeEvent(event: StoredEvent): string {
    const data = event.eventData as Record<string, unknown> | null;

    switch (event.eventType) {
      case 'message':
        return `消息: ${String(data?.content || '').slice(0, 50)}...`;
      case 'tool_call_start':
      case 'tool_start':
        return `工具开始: ${data?.tool || data?.name || 'unknown'}`;
      case 'tool_call_end':
      case 'tool_result':
        return `工具结果: ${data?.tool || data?.name || 'unknown'}`;
      case 'thinking':
        return `思考中...`;
      case 'error':
        return `错误: ${data?.message || 'unknown'}`;
      case 'agent_complete':
        return '完成';
      case 'agent_cancelled':
        return '已取消';
      default:
        return event.eventType;
    }
  }

  /**
   * 清理旧事件（可选，用于数据库维护）
   */
  async dispose(): Promise<void> {
    this.insertStmt = null;
  }
}

// Singleton export
let eventServiceInstance: SessionEventService | null = null;

export function getSessionEventService(): SessionEventService {
  if (!eventServiceInstance) {
    eventServiceInstance = SessionEventService.getInstance();
  }
  return eventServiceInstance;
}

let livenessProbeTimer: ReturnType<typeof setInterval> | null = null;

/** One unref'd timer per process. A second call does not arm another timer. */
export function startSessionEventLivenessProbe(): void {
  if (livenessProbeTimer) return;
  const timer = setInterval(() => {
    try {
      runSessionEventLivenessProbe();
    } catch (error) {
      try {
        const detail = describeFailure(error);
        logger.warn('session event liveness probe failed', {
          error: detail.message,
          stack: detail.stack,
          cause: detail.cause,
        });
      } catch {
        // 探针自己的失败不能冒泡到定时器宿主。
      }
    }
  }, SESSION_EVENT_LIVENESS_INTERVAL_MS);
  timer.unref();
  livenessProbeTimer = timer;
}

function runSessionEventLivenessProbe(): void {
  const db = getDatabase();
  if (!db.isReady) return;
  const sqlite = db.getDb();
  if (!sqlite) return;
  getSessionEventService().probeSessionEventLiveness(sqlite, Date.now());
}
