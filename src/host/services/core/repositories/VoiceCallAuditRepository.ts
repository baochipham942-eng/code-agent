// ============================================================================
// 语音通话审计的只读查询（N-L7-AUDIT）
//
// 只做读取聚合，不新建写路径：摘要卡/字幕/派活轮本来就落在 messages 表，
// 这里按 metadata 特征把它们捞出来供时间线拼装。append-only 不变量零触碰。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type { MessageMetadata } from '../../../../shared/contract/message';

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
  metadata: string | null;
}

export interface VoiceAuditMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  metadata: MessageMetadata | null;
}

function rowToMessage(row: MessageRow): VoiceAuditMessage {
  let metadata: MessageMetadata | null = null;
  try {
    metadata = row.metadata ? (JSON.parse(row.metadata) as MessageMetadata) : null;
  } catch {
    // 解析不了的 metadata 按 null 处理；调用方会把这条按「无键」归类，不静默丢行。
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    metadata,
  };
}

export class VoiceCallAuditRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** 全库通话摘要卡（按结束时间倒序）。LIKE 只做粗筛，真判定看解析后的 metadata。 */
  listCallSummaries(limit = 50): VoiceAuditMessage[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, timestamp, metadata FROM messages
      WHERE role = 'system' AND metadata LIKE '%voiceCallSummary%'
      ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as MessageRow[];
    return rows.map(rowToMessage).filter((m) => m.metadata?.voiceCallSummary);
  }

  /**
   * 一通电话窗口内的语音相关消息（字幕 / 派活轮 / 失败留痕 / 摘要卡）。
   * 窗口是兜底：新记录靠 metadata.voiceCallId 精确匹配，旧记录只能按窗推导。
   */
  getVoiceMessagesInWindow(sessionId: string, from: number, to: number): VoiceAuditMessage[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, timestamp, metadata FROM messages
      WHERE session_id = ? AND timestamp BETWEEN ? AND ?
        AND (
          metadata LIKE '%"source":"voice"%'
          OR metadata LIKE '%voiceDispatch%'
          OR metadata LIKE '%voiceCallFailure%'
          OR metadata LIKE '%voiceWorkFailure%'
          OR metadata LIKE '%voiceWorkSettled%'
        )
      ORDER BY timestamp ASC, id ASC
    `).all(sessionId, from, to) as MessageRow[];
    return rows.map(rowToMessage);
  }
}
