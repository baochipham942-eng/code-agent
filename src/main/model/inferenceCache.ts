// ============================================================================
// Inference Cache - LRU cache for deduplicating model inference requests
// ============================================================================

import { createHash } from 'crypto';
import { createLogger } from '../services/infra/logger';
import type { ModelMessage, ModelResponse } from './types';
import type { ModelConfig } from '../../shared/types';

const logger = createLogger('InferenceCache');

interface CacheEntry {
  response: ModelResponse;
  timestamp: number;
  hitCount: number;
}

export class InferenceCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 50, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Compute cache key from last 3 messages + model config
   */
  computeKey(messages: ModelMessage[], config: ModelConfig): string {
    const lastMessages = messages.slice(-3);
    const keyData = JSON.stringify({
      messages: lastMessages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      provider: config.provider,
      model: config.model,
    });
    return createHash('md5').update(keyData).digest('hex');
  }

  /**
   * Get cached response
   */
  get(key: string): ModelResponse | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    entry.hitCount++;
    this.hits++;
    logger.debug(`Cache hit (${this.hits} total hits, key=${key.substring(0, 8)})`);
    return entry.response;
  }

  /**
   * Store response in cache
   */
  set(key: string, response: ModelResponse): void {
    // Only cache text responses (not tool_use)
    if (response.type !== 'text') return;

    // LRU eviction
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.findOldest();
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      hitCount: 0,
    });
  }

  /**
   * Get cache statistics
   */
  getStats(): { hits: number; misses: number; size: number; hitRate: string } {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%';
    return { hits: this.hits, misses: this.misses, size: this.cache.size, hitRate };
  }

  private findOldest(): string | null {
    let oldest: { key: string; timestamp: number } | null = null;
    for (const [key, entry] of this.cache.entries()) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = { key, timestamp: entry.timestamp };
      }
    }
    return oldest?.key ?? null;
  }
}

// Singleton
let instance: InferenceCache | null = null;
export function getInferenceCache(): InferenceCache {
  if (!instance) instance = new InferenceCache();
  return instance;
}
