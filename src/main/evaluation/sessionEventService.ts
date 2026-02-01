// ============================================================================
// Session Event Service - 会话事件存储服务
// ============================================================================
// 存储完整的 SSE 事件流，用于评测分析
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { AgentEvent } from '../../shared/types';

const logger = createLogger('SessionEventService');

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private insertStmt: any = null;

  private constructor() {}

  static getInstance(): SessionEventService {
    if (!SessionEventService.instance) {
      SessionEventService.instance = new SessionEventService();
    }
    return SessionEventService.instance;
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
      const eventData = event.data ? JSON.stringify(event.data) : null;

      this.insertStmt.run(
        sessionId,
        event.type,
        eventData,
        Date.now()
      );
    } catch (error) {
      // 静默失败，不影响主流程
      logger.debug('Failed to save event', { error, eventType: event.type });
    }
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
      eventData: row.event_data ? JSON.parse(row.event_data) : null,
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
      eventData: row.event_data ? JSON.parse(row.event_data) : null,
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
      // 统计事件类型
      eventStats[event.eventType] = (eventStats[event.eventType] || 0) + 1;

      // 提取工具调用
      if (event.eventType === 'tool_start' || event.eventType === 'tool_result') {
        const data = event.eventData as Record<string, unknown>;
        if (data?.tool || data?.name) {
          const toolName = (data.tool || data.name) as string;
          const existing = toolCalls.find(t => t.name === toolName);
          if (!existing && event.eventType === 'tool_start') {
            toolCalls.push({
              name: toolName,
              success: true, // 默认成功，后续更新
            });
          }
          if (event.eventType === 'tool_result' && data.error) {
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
      case 'tool_start':
        return `工具开始: ${data?.tool || data?.name || 'unknown'}`;
      case 'tool_result':
        return `工具结果: ${data?.tool || data?.name || 'unknown'}`;
      case 'thinking':
        return `思考中...`;
      case 'error':
        return `错误: ${data?.message || 'unknown'}`;
      case 'agent_complete':
        return '完成';
      default:
        return event.eventType;
    }
  }

  /**
   * 清理旧事件（可选，用于数据库维护）
   */
  cleanupOldEvents(olderThanDays: number = 30): number {
    const db = this.getDb();
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const result = db.prepare(`
      DELETE FROM session_events
      WHERE timestamp < ?
    `).run(cutoff);

    logger.info('Cleaned up old events', { deleted: result.changes, olderThanDays });
    return result.changes;
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
