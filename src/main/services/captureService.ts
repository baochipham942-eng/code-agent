// ============================================================================
// CaptureService - 浏览器采集内容处理服务
// ============================================================================

import crypto from 'crypto';
import { createLogger } from './infra/logger';
import { getDatabase } from './core/databaseService';
import type { CaptureItem, CaptureRequest, CaptureSearchResult, CaptureStats, CaptureSource } from '@shared/types/capture';

const logger = createLogger('CaptureService');

/**
 * 采集服务：接收浏览器插件/手动采集的内容，存储并向量化
 * 优先使用 DB 持久化，DB 不可用时 fallback 到内存 Map
 */
export class CaptureService {
  private items: Map<string, CaptureItem> = new Map();
  private vectorStore: { add: (content: string, metadata: Record<string, unknown>) => Promise<string>; searchAsync: (query: string, options?: Record<string, unknown>) => Promise<Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }>> } | null = null;

  private get db() {
    try {
      const db = getDatabase();
      return db.getDb() ? db : null;
    } catch {
      return null;
    }
  }

  /**
   * 注入 VectorStore 实例（延迟注入，避免循环依赖）
   */
  setVectorStore(vs: typeof this.vectorStore): void {
    this.vectorStore = vs;
  }

  /**
   * 采集内容
   */
  async capture(request: CaptureRequest): Promise<CaptureItem> {
    const id = `cap_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;
    const now = Date.now();

    // 生成摘要（取前 200 字符）
    const summary = request.content.length > 200
      ? request.content.substring(0, 200) + '...'
      : request.content;

    const item: CaptureItem = {
      id,
      url: request.url,
      title: request.title,
      content: request.content,
      summary,
      source: request.source || 'browser_extension',
      tags: request.tags || [],
      metadata: request.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    // 存储：优先 DB，fallback Map
    const db = this.db;
    if (db) {
      try {
        db.createCapture(item);
      } catch (error) {
        logger.warn('DB createCapture failed, falling back to memory', { error });
        this.items.set(id, item);
      }
    } else {
      this.items.set(id, item);
    }

    // 向量化存储（异步，不阻塞）
    if (this.vectorStore) {
      try {
        await this.vectorStore.add(request.content, {
          source: 'web_capture',
          captureId: id,
          url: request.url,
          title: request.title,
          timestamp: now,
        });
        logger.info('Content vectorized', { id, title: request.title });
      } catch (error) {
        logger.warn('Failed to vectorize content', { id, error });
      }
    }

    logger.info('Content captured', { id, title: request.title, source: item.source });
    return item;
  }

  /**
   * 获取采集项列表
   */
  list(options?: { source?: CaptureSource; limit?: number; offset?: number }): CaptureItem[] {
    const db = this.db;
    if (db) {
      try {
        return db.listCaptures(options);
      } catch (error) {
        logger.warn('DB listCaptures failed, falling back to memory', { error });
      }
    }

    // Fallback: 内存
    let items = Array.from(this.items.values());
    if (options?.source) {
      items = items.filter(i => i.source === options.source);
    }
    items.sort((a, b) => b.createdAt - a.createdAt);
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;
    return items.slice(offset, offset + limit);
  }

  /**
   * 搜索采集内容
   */
  async search(query: string, topK: number = 10): Promise<CaptureSearchResult[]> {
    // 优先用向量搜索
    if (this.vectorStore) {
      try {
        const results = await this.vectorStore.searchAsync(query, {
          topK,
          filter: { source: 'web_capture' },
        });

        return results.map(r => {
          const captureId = (r.metadata as Record<string, unknown>)?.captureId as string;
          const item = captureId ? this.get(captureId) : undefined;
          return {
            item: item || {
              id: r.id,
              title: ((r.metadata as Record<string, unknown>)?.title as string) || 'Unknown',
              content: r.content,
              source: 'browser_extension' as CaptureSource,
              tags: [],
              metadata: {},
              createdAt: ((r.metadata as Record<string, unknown>)?.timestamp as number) || Date.now(),
              updatedAt: ((r.metadata as Record<string, unknown>)?.timestamp as number) || Date.now(),
            },
            score: r.score,
          };
        });
      } catch (error) {
        logger.warn('Vector search failed, falling back to text search', { error });
      }
    }

    // 降级：DB 文本搜索
    const db = this.db;
    if (db) {
      try {
        const items = db.searchCaptures(query, topK);
        return items.map(item => ({ item, score: 1.0 }));
      } catch (error) {
        logger.warn('DB searchCaptures failed, falling back to memory', { error });
      }
    }

    // 最终降级：内存搜索
    const queryLower = query.toLowerCase();
    return Array.from(this.items.values())
      .filter(item =>
        item.title.toLowerCase().includes(queryLower) ||
        item.content.toLowerCase().includes(queryLower) ||
        item.tags.some(t => t.toLowerCase().includes(queryLower))
      )
      .map(item => ({ item, score: 1.0 }))
      .slice(0, topK);
  }

  /**
   * 获取单个采集项
   */
  get(id: string): CaptureItem | undefined {
    const db = this.db;
    if (db) {
      try {
        return db.getCapture(id);
      } catch {
        // fallback
      }
    }
    return this.items.get(id);
  }

  /**
   * 删除采集项
   */
  delete(id: string): boolean {
    const db = this.db;
    if (db) {
      try {
        return db.deleteCapture(id);
      } catch {
        // fallback
      }
    }
    return this.items.delete(id);
  }

  /**
   * 获取统计信息
   */
  getStats(): CaptureStats {
    const db = this.db;
    if (db) {
      try {
        return db.getCaptureStats();
      } catch {
        // fallback
      }
    }

    const items = Array.from(this.items.values());
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const bySource: Record<CaptureSource, number> = {
      browser_extension: 0,
      manual: 0,
      wechat: 0,
      local_file: 0,
    };

    for (const item of items) {
      bySource[item.source] = (bySource[item.source] || 0) + 1;
    }

    return {
      total: items.length,
      bySource,
      recentlyAdded: items.filter(i => i.createdAt > weekAgo).length,
    };
  }
}

// 单例
let instance: CaptureService | null = null;

export function getCaptureService(): CaptureService {
  if (!instance) {
    instance = new CaptureService();
  }
  return instance;
}
