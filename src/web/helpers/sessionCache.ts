// ============================================================================
// In-memory session / message cache facade
// ============================================================================
//
// Web 模式下 better-sqlite3 native module 不可用，
// 用内存缓存维持多轮上下文和会话列表。

// ── 类型 ──

export interface CachedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CachedMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolCalls?: CachedToolCall[];
  thinking?: string;
}

export interface InMemorySession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isArchived?: boolean;
  archivedAt?: number;
  messageCount: number;
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

/** 设置 dbAvailable 标志（仅由 webServer 初始化逻辑调用） */
export function setDbAvailable(value: boolean): void {
  dbAvailable = value;
}
