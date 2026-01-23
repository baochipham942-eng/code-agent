// ============================================================================
// Session Local Cache - In-memory cache for session data with LRU eviction
// ============================================================================
// Provides caching for historical messages and session data with:
// - LRU (Least Recently Used) eviction strategy
// - Session ID-based queries
// - Configurable size limits
// - Persistence support (optional)
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionLocalCache');

// Default cache directory
const CACHE_DIR = path.join(os.homedir(), '.code-agent', 'cache', 'sessions');

/**
 * Cache entry with metadata
 */
export interface CacheEntry<T> {
  /** The cached value */
  value: T;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp */
  accessedAt: number;
  /** Access count */
  accessCount: number;
  /** Size in bytes (estimated) */
  size: number;
  /** Time-to-live in ms (0 = no expiry) */
  ttl: number;
}

/**
 * Message structure for session caching
 */
export interface CachedMessage {
  /** Message ID */
  id: string;
  /** Message role */
  role: 'user' | 'assistant' | 'system';
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: number;
  /** Token count (estimated) */
  tokens?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Session data structure
 */
export interface CachedSession {
  /** Session ID */
  sessionId: string;
  /** Messages in this session */
  messages: CachedMessage[];
  /** Session start time */
  startedAt: number;
  /** Last activity time */
  lastActivityAt: number;
  /** Total tokens used */
  totalTokens: number;
  /** Session metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total entries */
  entryCount: number;
  /** Total size in bytes */
  totalSize: number;
  /** Hit count */
  hits: number;
  /** Miss count */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
  /** Eviction count */
  evictions: number;
}

/**
 * LRU Cache implementation
 */
export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private maxSize: number;
  private maxEntries: number;
  private currentSize: number = 0;
  private stats: CacheStats = {
    entryCount: 0,
    totalSize: 0,
    hits: 0,
    misses: 0,
    hitRate: 0,
    evictions: 0,
  };

  constructor(options: { maxSize?: number; maxEntries?: number } = {}) {
    this.maxSize = options.maxSize || 50 * 1024 * 1024; // 50MB default
    this.maxEntries = options.maxEntries || 1000;
  }

  /**
   * Get an entry from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Check TTL
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this.delete(key);
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Update access stats
    entry.accessedAt = Date.now();
    entry.accessCount++;
    this.stats.hits++;
    this.updateHitRate();

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set an entry in cache
   */
  set(key: string, value: T, options: { ttl?: number } = {}): void {
    const size = this.estimateSize(value);

    // Remove existing entry if present
    if (this.cache.has(key)) {
      this.delete(key);
    }

    // Evict if necessary
    while (
      (this.currentSize + size > this.maxSize ||
        this.cache.size >= this.maxEntries) &&
      this.cache.size > 0
    ) {
      this.evictOldest();
    }

    const entry: CacheEntry<T> = {
      value,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 1,
      size,
      ttl: options.ttl || 0,
    };

    this.cache.set(key, entry);
    this.currentSize += size;
    this.stats.entryCount = this.cache.size;
    this.stats.totalSize = this.currentSize;
  }

  /**
   * Delete an entry
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(key);
      this.stats.entryCount = this.cache.size;
      this.stats.totalSize = this.currentSize;
      return true;
    }
    return false;
  }

  /**
   * Check if key exists
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check TTL
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
    this.stats.entryCount = 0;
    this.stats.totalSize = 0;
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Evict oldest entry (LRU)
   */
  private evictOldest(): void {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) {
      this.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  /**
   * Estimate size of value in bytes
   */
  private estimateSize(value: T): number {
    const str = JSON.stringify(value);
    return str.length * 2; // Approximate UTF-16 encoding
  }

  /**
   * Update hit rate
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

/**
 * Session Local Cache - Specialized cache for session data
 */
export class SessionLocalCache {
  private sessionCache: LRUCache<CachedSession>;
  private persistPath: string | null;

  constructor(options: {
    maxSize?: number;
    maxSessions?: number;
    persistPath?: string;
  } = {}) {
    this.sessionCache = new LRUCache({
      maxSize: options.maxSize || 100 * 1024 * 1024, // 100MB
      maxEntries: options.maxSessions || 100,
    });
    this.persistPath = options.persistPath || null;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): CachedSession | undefined {
    return this.sessionCache.get(sessionId);
  }

  /**
   * Save or update a session
   */
  setSession(session: CachedSession): void {
    session.lastActivityAt = Date.now();
    this.sessionCache.set(session.sessionId, session);
  }

  /**
   * Add a message to a session
   */
  addMessage(sessionId: string, message: CachedMessage): void {
    let session = this.sessionCache.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        messages: [],
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        totalTokens: 0,
      };
    }

    session.messages.push(message);
    session.lastActivityAt = Date.now();
    session.totalTokens += message.tokens || 0;

    this.sessionCache.set(sessionId, session);
  }

  /**
   * Get messages from a session
   */
  getMessages(
    sessionId: string,
    options: { limit?: number; offset?: number; since?: number } = {}
  ): CachedMessage[] {
    const session = this.sessionCache.get(sessionId);
    if (!session) return [];

    let messages = session.messages;

    // Filter by timestamp
    if (options.since) {
      messages = messages.filter(m => m.timestamp >= options.since!);
    }

    // Apply offset and limit
    const offset = options.offset || 0;
    const limit = options.limit || messages.length;

    return messages.slice(offset, offset + limit);
  }

  /**
   * Search messages across sessions
   */
  searchMessages(
    query: string,
    options: { sessionId?: string; limit?: number } = {}
  ): Array<{ sessionId: string; message: CachedMessage }> {
    const results: Array<{ sessionId: string; message: CachedMessage }> = [];
    const limit = options.limit || 50;
    const searchLower = query.toLowerCase();

    const sessionIds = options.sessionId
      ? [options.sessionId]
      : this.sessionCache.keys();

    for (const sessionId of sessionIds) {
      const session = this.sessionCache.get(sessionId);
      if (!session) continue;

      for (const message of session.messages) {
        if (message.content.toLowerCase().includes(searchLower)) {
          results.push({ sessionId, message });
          if (results.length >= limit) break;
        }
      }

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    return this.sessionCache.delete(sessionId);
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return this.sessionCache.keys();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return this.sessionCache.getStats();
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessionCache.clear();
  }

  /**
   * Persist cache to disk
   */
  async persist(): Promise<void> {
    if (!this.persistPath) return;

    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });

      const data: Record<string, CachedSession> = {};
      for (const sessionId of this.sessionCache.keys()) {
        const session = this.sessionCache.get(sessionId);
        if (session) {
          data[sessionId] = session;
        }
      }

      await fs.writeFile(this.persistPath, JSON.stringify(data), 'utf-8');
      logger.debug('Cache persisted', { path: this.persistPath });
    } catch (error) {
      logger.error('Failed to persist cache', { error });
    }
  }

  /**
   * Load cache from disk
   */
  async load(): Promise<void> {
    if (!this.persistPath) return;

    try {
      const content = await fs.readFile(this.persistPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, CachedSession>;

      for (const [sessionId, session] of Object.entries(data)) {
        this.sessionCache.set(sessionId, session);
      }

      logger.debug('Cache loaded', {
        path: this.persistPath,
        sessions: Object.keys(data).length,
      });
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load cache', { error });
      }
    }
  }
}

// Export singleton for convenience
let defaultCache: SessionLocalCache | null = null;

export function getDefaultCache(): SessionLocalCache {
  if (!defaultCache) {
    defaultCache = new SessionLocalCache({
      persistPath: path.join(CACHE_DIR, 'sessions.json'),
    });
  }
  return defaultCache;
}
