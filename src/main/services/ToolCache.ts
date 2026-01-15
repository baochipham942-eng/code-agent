// ============================================================================
// Tool Cache - 工具结果缓存（短期记忆）
// ============================================================================

import { getDatabase } from './DatabaseService';
import type { ToolResult } from '../../shared/types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CacheEntry {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  createdAt: number;
  expiresAt: number | null;
  hitCount: number;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
}

// 工具缓存策略配置
export interface ToolCacheConfig {
  // 默认 TTL（毫秒）
  defaultTTL: number;
  // 最大内存缓存条目
  maxMemoryEntries: number;
  // 是否启用持久化缓存
  persistentCache: boolean;
}

// 不同工具的缓存策略
const TOOL_CACHE_POLICIES: Record<string, { ttl: number; cacheable: boolean }> = {
  // 文件读取 - 缓存 5 分钟（文件可能被修改）
  read_file: { ttl: 5 * 60 * 1000, cacheable: true },

  // 目录列表 - 缓存 2 分钟
  list_directory: { ttl: 2 * 60 * 1000, cacheable: true },

  // Glob 搜索 - 缓存 2 分钟
  glob: { ttl: 2 * 60 * 1000, cacheable: true },

  // Grep 搜索 - 缓存 2 分钟
  grep: { ttl: 2 * 60 * 1000, cacheable: true },

  // 文件写入 - 不缓存（有副作用）
  write_file: { ttl: 0, cacheable: false },

  // 文件编辑 - 不缓存（有副作用）
  edit_file: { ttl: 0, cacheable: false },

  // Bash 命令 - 不缓存（可能有副作用）
  bash: { ttl: 0, cacheable: false },

  // Web Fetch - 缓存 15 分钟
  web_fetch: { ttl: 15 * 60 * 1000, cacheable: true },

  // Task (子代理) - 不缓存
  task: { ttl: 0, cacheable: false },

  // 默认策略
  default: { ttl: 5 * 60 * 1000, cacheable: true },
};

// ----------------------------------------------------------------------------
// Tool Cache Service
// ----------------------------------------------------------------------------

export class ToolCache {
  private config: ToolCacheConfig;
  private memoryCache: Map<string, CacheEntry> = new Map();
  private stats: { hits: number; misses: number } = { hits: 0, misses: 0 };
  private sessionId: string | null = null;

  constructor(config?: Partial<ToolCacheConfig>) {
    this.config = {
      defaultTTL: 5 * 60 * 1000, // 5 分钟
      maxMemoryEntries: 100,
      persistentCache: true,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  // --------------------------------------------------------------------------
  // Cache Operations
  // --------------------------------------------------------------------------

  /**
   * 生成缓存键
   */
  private generateKey(toolName: string, args: Record<string, unknown>): string {
    // 排序参数以确保相同参数生成相同的 key
    const sortedArgs = Object.keys(args)
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as Record<string, unknown>);

    return `${toolName}:${JSON.stringify(sortedArgs)}`;
  }

  /**
   * 检查工具是否可缓存
   */
  isCacheable(toolName: string): boolean {
    const policy = TOOL_CACHE_POLICIES[toolName] || TOOL_CACHE_POLICIES['default'];
    return policy.cacheable;
  }

  /**
   * 获取工具的 TTL
   */
  getTTL(toolName: string): number {
    const policy = TOOL_CACHE_POLICIES[toolName] || TOOL_CACHE_POLICIES['default'];
    return policy.ttl || this.config.defaultTTL;
  }

  /**
   * 从缓存获取结果
   */
  get(toolName: string, args: Record<string, unknown>): ToolResult | null {
    // 检查是否可缓存
    if (!this.isCacheable(toolName)) {
      return null;
    }

    const key = this.generateKey(toolName, args);
    const now = Date.now();

    // 先检查内存缓存
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      if (memoryEntry.expiresAt === null || memoryEntry.expiresAt > now) {
        memoryEntry.hitCount++;
        this.stats.hits++;
        return memoryEntry.result;
      } else {
        // 过期，删除
        this.memoryCache.delete(key);
      }
    }

    // 检查持久化缓存
    if (this.config.persistentCache) {
      try {
        const db = getDatabase();
        const dbResult = db.getCachedToolResult(toolName, args);
        if (dbResult) {
          // 添加到内存缓存
          this.setMemoryCache(key, {
            toolName,
            args,
            result: dbResult,
            createdAt: now,
            expiresAt: now + this.getTTL(toolName),
            hitCount: 1,
          });
          this.stats.hits++;
          return dbResult;
        }
      } catch (error) {
        console.error('Failed to get cached tool result from DB:', error);
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * 将结果存入缓存
   */
  set(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    customTTL?: number
  ): void {
    // 检查是否可缓存
    if (!this.isCacheable(toolName)) {
      return;
    }

    // 只缓存成功的结果
    if (!result.success) {
      return;
    }

    const key = this.generateKey(toolName, args);
    const now = Date.now();
    const ttl = customTTL ?? this.getTTL(toolName);
    const expiresAt = ttl > 0 ? now + ttl : null;

    // 存入内存缓存
    this.setMemoryCache(key, {
      toolName,
      args,
      result,
      createdAt: now,
      expiresAt,
      hitCount: 0,
    });

    // 存入持久化缓存
    if (this.config.persistentCache && this.sessionId) {
      try {
        const db = getDatabase();
        db.saveToolExecution(this.sessionId, null, toolName, args, result, ttl);
      } catch (error) {
        console.error('Failed to save tool result to DB:', error);
      }
    }
  }

  /**
   * 设置内存缓存（带 LRU 淘汰）
   */
  private setMemoryCache(key: string, entry: CacheEntry): void {
    // 如果超过最大条目数，删除最少使用的
    if (this.memoryCache.size >= this.config.maxMemoryEntries) {
      let minHitKey: string | null = null;
      let minHitCount = Infinity;

      for (const [k, v] of this.memoryCache.entries()) {
        if (v.hitCount < minHitCount) {
          minHitCount = v.hitCount;
          minHitKey = k;
        }
      }

      if (minHitKey) {
        this.memoryCache.delete(minHitKey);
      }
    }

    this.memoryCache.set(key, entry);
  }

  /**
   * 使指定工具的缓存失效
   */
  invalidate(toolName: string, args?: Record<string, unknown>): void {
    if (args) {
      const key = this.generateKey(toolName, args);
      this.memoryCache.delete(key);
    } else {
      // 删除该工具的所有缓存
      for (const key of this.memoryCache.keys()) {
        if (key.startsWith(`${toolName}:`)) {
          this.memoryCache.delete(key);
        }
      }
    }
  }

  /**
   * 文件修改时使相关缓存失效
   */
  invalidateForPath(filePath: string): void {
    // 使与该文件相关的所有缓存失效
    for (const [key, entry] of this.memoryCache.entries()) {
      const args = entry.args;
      if (
        args.path === filePath ||
        args.file_path === filePath ||
        (typeof args.directory === 'string' && filePath.startsWith(args.directory))
      ) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.memoryCache.clear();
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * 清理过期缓存
   */
  cleanExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }

    // 清理持久化缓存
    if (this.config.persistentCache) {
      try {
        const db = getDatabase();
        cleaned += db.cleanExpiredCache();
      } catch (error) {
        console.error('Failed to clean expired cache from DB:', error);
      }
    }

    return cleaned;
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      totalEntries: this.memoryCache.size,
      hitCount: this.stats.hits,
      missCount: this.stats.misses,
      hitRate: totalRequests > 0 ? this.stats.hits / totalRequests : 0,
    };
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0 };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let cacheInstance: ToolCache | null = null;

export function getToolCache(): ToolCache {
  if (!cacheInstance) {
    cacheInstance = new ToolCache();
  }
  return cacheInstance;
}

export function initToolCache(config?: Partial<ToolCacheConfig>): ToolCache {
  cacheInstance = new ToolCache(config);
  return cacheInstance;
}
