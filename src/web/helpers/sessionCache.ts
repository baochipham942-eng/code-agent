// ============================================================================
// In-memory session / message cache facade
// ============================================================================
//
// Web 模式下 better-sqlite3 native module 不可用，
// 用内存缓存维持多轮上下文和会话列表。

// ── 类型 ──

import type { Message, MessageAttachment, PersistenceHealth } from '../../shared/contract';

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
  thinking?: string;
  contentParts?: CachedContentPart[];
  attachments?: MessageAttachment[];
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

// ── 缓存实例 ──

/** 每个会话的消息缓存 */
export const sessionMessages = new Map<string, CachedMessage[]>();

/** 最多缓存的会话数量 */
export const SESSION_CACHE_MAX = 50;

/** 内存会话存储（better-sqlite3 不可用时的降级方案） */
export const inMemorySessions = new Map<string, InMemorySession>();

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

export function getPersistenceHealth(): PersistenceHealth {
  return { ...persistenceHealth };
}

function enforceSessionCacheLimit(): void {
  if (sessionMessages.size <= SESSION_CACHE_MAX) return;
  const oldestKey = sessionMessages.keys().next().value;
  if (oldestKey) sessionMessages.delete(oldestKey);
}

export function toCachedSessionMessages(messages: Message[]): CachedMessage[] {
  return messages
    .map((message): CachedMessage | null => {
      if (message.role !== 'user' && message.role !== 'assistant') {
        return null;
      }

      return {
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        toolCalls: message.toolCalls as CachedToolCall[] | undefined,
        thinking: message.thinking || message.reasoning,
        contentParts: message.contentParts as CachedContentPart[] | undefined,
        attachments: message.attachments,
      };
    })
    .filter((message): message is CachedMessage => Boolean(message));
}

export function seedSessionMessagesFromPersisted(sessionId: string, messages: Message[]): CachedMessage[] {
  const cached = toCachedSessionMessages(messages);
  if (cached.length > 0) {
    sessionMessages.set(sessionId, cached);
    enforceSessionCacheLimit();
  }
  return cached;
}
