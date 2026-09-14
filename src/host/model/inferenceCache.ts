// ============================================================================
// Inference Cache - LRU cache for deduplicating model inference requests
// ============================================================================

import { createHash } from 'crypto';
import { createLogger } from '../services/infra/logger';
import type { InferenceOptions, ModelMessage, ModelResponse } from './types';
import type { ModelConfig, ToolDefinition } from '../../shared/contract';

const logger = createLogger('InferenceCache');

/**
 * 递归按键排序的稳定序列化：同内容不同键序必须得到同一个 key，
 * 否则等价请求会因对象字面量的构造顺序不同而互相 miss。
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** 消息里所有会进 provider 请求体的字段（不止 role/content）。 */
function serializeMessage(message: ModelMessage): unknown {
  return {
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolError: message.toolError,
    toolCallText: message.toolCallText,
    thinking: message.thinking,
    responsesOutput: message.responsesOutput,
    transient: message.transient,
  };
}

/** 工具里模型可见的三个字段：name/description/inputSchema（schema 递归稳定序列化）。 */
function serializeTool(tool: ToolDefinition): unknown {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

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
   * Compute cache key from the full request payload: all messages (not just
   * the tail), tools, output-affecting config fields, and output-affecting
   * inference options. reasoningEffort folds options over config to mirror
   * the provider precedence (`options?.reasoningEffort ?? config.reasoningEffort`).
   *
   * Deliberately NOT in the key: apiKey (credential, not output-affecting),
   * capabilities/computerUse (descriptive metadata), promptCaching (server-side
   * cache marker, output-transparent), adaptive (routing permission — response
   * ownership is handled by keying writes with the config that produced them).
   */
  computeKey(
    messages: ModelMessage[],
    config: ModelConfig,
    tools: ToolDefinition[],
    options?: InferenceOptions,
  ): string {
    const keyData = stableStringify({
      messages: messages.map(serializeMessage),
      tools: tools.map(serializeTool),
      provider: config.provider,
      model: config.model,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      responseFormat: config.responseFormat,
      thinkingBudget: config.thinkingBudget,
      reasoningEffort: options?.reasoningEffort ?? config.reasoningEffort,
      searchEnabled: options?.searchEnabled !== false,
      toolChoice: options?.toolChoice,
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
