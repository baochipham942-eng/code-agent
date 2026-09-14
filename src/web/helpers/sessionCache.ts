// ============================================================================
// In-memory session / message cache facade
// ============================================================================
//
// Web 模式下 better-sqlite3 native module 不可用，
// 用内存缓存维持多轮上下文和会话列表。

// ── 类型 ──

import type { Artifact, Message, MessageAttachment, PersistenceHealth } from '../../shared/contract';
import { SQLITE_FTS, SQLITE_INTEGRITY } from '../../shared/constants';
import type { DbIntegrityOutcome } from '../../host/services/core/database/integrityGate';
import { sanitizeAttachmentsForPersistence, stripInlineAttachmentBlocks } from '../../shared/utils/messageAttachments';
import { getDisabledFtsTables, getEmptyRecreatedFtsTables } from '../../host/services/core/database/ftsRepair';

export interface CachedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> };
}

export type CachedContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string };

export interface CachedMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: CachedToolCall[];
  toolResults?: Message['toolResults'];
  thinking?: string;
  contentParts?: CachedContentPart[];
  artifacts?: Artifact[];
  attachments?: MessageAttachment[];
  metadata?: Message['metadata'];
  visibility?: Message['visibility'];
  isMeta?: boolean;
}

export interface InMemorySession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isArchived?: boolean;
  archivedAt?: number;
  messageCount: number;
  workingDirectory?: string;
}

/** DB 是否可用 — 在 initializeServices 中设置 */
export let dbAvailable = false;

const PERSISTENCE_AVAILABLE_MESSAGE = '历史会持久化到本机数据库。';
const PERSISTENCE_UNAVAILABLE_MESSAGE = '历史持久化不可用，当前只会话内有效。';

let persistenceHealth: PersistenceHealth = {
  status: 'unavailable',
  mode: 'memory',
  durable: false,
  message: PERSISTENCE_UNAVAILABLE_MESSAGE,
  checkedAt: Date.now(),
};

function formatPersistenceFailureReason(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === SQLITE_INTEGRITY.CORRUPT_NO_BACKUP) return SQLITE_INTEGRITY.CORRUPT_NO_BACKUP;
  }
  if (error instanceof Error) return error.message;
  const reason = String(error);
  return reason.length > 0 ? reason : undefined;
}

/** 设置 dbAvailable 标志（仅由 webServer 初始化逻辑调用） */
export function setDbAvailable(value: boolean, error?: unknown): void {
  dbAvailable = value;
  persistenceHealth = value
    ? {
        status: 'available',
        mode: 'database',
        durable: true,
        message: PERSISTENCE_AVAILABLE_MESSAGE,
        checkedAt: Date.now(),
      }
    : {
        status: 'unavailable',
        mode: 'memory',
        durable: false,
        message: PERSISTENCE_UNAVAILABLE_MESSAGE,
        reason: formatPersistenceFailureReason(error),
        checkedAt: Date.now(),
      };
}

function markPersistenceRecovered(backupTakenAt: number): void {
  dbAvailable = true;
  persistenceHealth = {
    status: 'recovered',
    mode: 'database',
    durable: true,
    message: 'Restored from a local backup.',
    reason: `${SQLITE_INTEGRITY.RECOVERED_FROM_BACKUP}:${new Date(backupTakenAt).toISOString()}`,
    checkedAt: Date.now(),
  };
}

export function markPersistenceDegraded(reason: string): void {
  if (!dbAvailable) return;
  if (persistenceHealth.status === 'unavailable') return;
  // recovered 是一次性事件通知，不遮挡持续性降级：quick_check 失败 / 局部损坏要顶掉它
  persistenceHealth = {
    ...persistenceHealth,
    status: 'degraded',
    reason,
    checkedAt: Date.now(),
  };
}

export function applyDbIntegrityOutcome(outcome: DbIntegrityOutcome): void {
  if (outcome.kind === 'recovered') {
    markPersistenceRecovered(outcome.backupTakenAt);
    return;
  }
  if (outcome.kind === 'local') {
    markPersistenceDegraded(SQLITE_INTEGRITY.LOCAL_CORRUPT);
  }
}

export function getPersistenceHealth(): PersistenceHealth {
  const health = { ...persistenceHealth };
  // FTS 降级是持续状态：available 和 recovered（一次性通知）都要被它覆盖
  if (health.status !== 'available' && health.status !== 'recovered') return health;
  if (getDisabledFtsTables().length > 0) {
    return {
      ...health,
      status: 'degraded',
      reason: SQLITE_FTS.DISABLED_REASON,
    };
  }
  if (getEmptyRecreatedFtsTables().length > 0) {
    return {
      ...health,
      status: 'degraded',
      reason: SQLITE_FTS.EMPTY_RECREATED_REASON,
    };
  }
  return health;
}

export function toCachedSessionMessages(messages: Message[]): CachedMessage[] {
  return messages
    .map((message): CachedMessage | null => {
      if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
        return null;
      }

      return {
        id: message.id,
        role: message.role,
        content: stripInlineAttachmentBlocks(message.content),
        timestamp: message.timestamp,
        toolCalls: message.toolCalls as CachedToolCall[] | undefined,
        ...(message.toolResults?.length ? { toolResults: message.toolResults } : {}),
        thinking: message.thinking || message.reasoning,
        contentParts: message.contentParts as CachedContentPart[] | undefined,
        artifacts: message.artifacts,
        attachments: sanitizeAttachmentsForPersistence(message.attachments),
        metadata: message.metadata,
        ...(message.visibility ? { visibility: message.visibility } : {}),
        ...(message.isMeta ? { isMeta: true } : {}),
      };
    })
    .filter((message): message is CachedMessage => Boolean(message));
}
