// ============================================================================
// Embedding Service - Advanced embedding with API support
// Supports DeepSeek, OpenAI, Gemini APIs with local fallback
// Features auto-fallback mechanism for resilience
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('EmbeddingService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface EmbeddingConfig {
  provider: 'deepseek' | 'openai' | 'gemini' | 'local';
  model?: string;
  dimension: number;
  batchSize: number;
  cacheEnabled: boolean;
  fallbackChain?: Array<'deepseek' | 'openai' | 'gemini' | 'local'>;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimension(): number;
}

// ----------------------------------------------------------------------------
// Local Embedding (TF-IDF Hash - Fallback)
// ----------------------------------------------------------------------------

export class LocalEmbedding implements EmbeddingProvider {
  private dimension: number;

  constructor(dimension: number = 384) {
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array(this.dimension).fill(0);
    const tokens = text.toLowerCase().split(/\s+/);

    for (const token of tokens) {
      const hash = this.hashString(token);
      const index = Math.abs(hash) % this.dimension;
      vector[index] += 1;
    }

    return this.normalize(vector);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  getDimension(): number {
    return this.dimension;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  private normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map((v) => v / magnitude);
  }
}

// ----------------------------------------------------------------------------
// DeepSeek Embedding
// ----------------------------------------------------------------------------

export class DeepSeekEmbedding implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimension: number = 1024; // DeepSeek embedding dimension

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.deepseek.com';
    this.model = model || 'deepseek-embed';
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek embedding error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    if (!data.data?.[0]?.embedding) {
      throw new Error('Invalid response from DeepSeek embedding API');
    }

    this.dimension = data.data[0].embedding.length;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // DeepSeek supports batch embedding
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek embedding error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  getDimension(): number {
    return this.dimension;
  }
}

// ----------------------------------------------------------------------------
// OpenAI Embedding
// ----------------------------------------------------------------------------

export class OpenAIEmbedding implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimension: number = 1536; // text-embedding-ada-002

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.openai.com';
    this.model = model || 'text-embedding-3-small';
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    if (!data.data?.[0]?.embedding) {
      throw new Error('Invalid response from OpenAI embedding API');
    }

    this.dimension = data.data[0].embedding.length;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  getDimension(): number {
    return this.dimension;
  }
}

// ----------------------------------------------------------------------------
// Gemini Embedding
// ----------------------------------------------------------------------------

export class GeminiEmbedding implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private dimension: number = 768; // text-embedding-004

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || 'text-embedding-004';
  }

  async embed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: {
          parts: [{ text }],
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini embedding error: ${error}`);
    }

    const data = await response.json() as {
      embedding: { values: number[] };
    };

    if (!data.embedding?.values) {
      throw new Error('Invalid response from Gemini embedding API');
    }

    this.dimension = data.embedding.values.length;
    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;

    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: {
        parts: [{ text }],
      },
    }));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini batch embedding error: ${error}`);
    }

    const data = await response.json() as {
      embeddings: Array<{ values: number[] }>;
    };

    if (!data.embeddings) {
      throw new Error('Invalid response from Gemini batch embedding API');
    }

    return data.embeddings.map((e) => e.values);
  }

  getDimension(): number {
    return this.dimension;
  }
}

// ----------------------------------------------------------------------------
// Embedding Service (with caching and auto-fallback)
// ----------------------------------------------------------------------------

export class EmbeddingService {
  private provider: EmbeddingProvider;
  private fallbackChain: EmbeddingProvider[] = [];
  private fallbackProvider: LocalEmbedding;
  private cache: Map<string, number[]> = new Map();
  private cacheEnabled: boolean;
  private maxCacheSize: number = 10000;
  private currentProviderIndex: number = 0;
  private failureCount: Map<number, number> = new Map();
  private readonly maxFailures: number = 3;

  constructor(config?: Partial<EmbeddingConfig>) {
    const defaultConfig: EmbeddingConfig = {
      provider: 'local',
      dimension: 384,
      batchSize: 100,
      cacheEnabled: true,
      fallbackChain: ['deepseek', 'openai', 'gemini', 'local'],
    };

    const finalConfig = { ...defaultConfig, ...config };
    this.cacheEnabled = finalConfig.cacheEnabled;
    this.fallbackProvider = new LocalEmbedding(finalConfig.dimension);

    // Initialize provider chain for fallback
    this.fallbackChain = this.initializeFallbackChain(finalConfig);
    this.provider = this.fallbackChain[0] || this.fallbackProvider;
  }

  private initializeFallbackChain(config: EmbeddingConfig): EmbeddingProvider[] {
    const chain: EmbeddingProvider[] = [];
    const chainConfig = config.fallbackChain || ['deepseek', 'openai', 'gemini', 'local'];

    for (const providerName of chainConfig) {
      const provider = this.createProvider(providerName, config.model);
      if (provider) {
        chain.push(provider);
        logger.debug(`Added ${providerName} to fallback chain`);
      }
    }

    // Always ensure local is available as final fallback
    if (chain.length === 0 || !(chain[chain.length - 1] instanceof LocalEmbedding)) {
      chain.push(this.fallbackProvider);
    }

    logger.info(`Embedding fallback chain initialized with ${chain.length} providers`);
    return chain;
  }

  private createProvider(
    name: 'deepseek' | 'openai' | 'gemini' | 'local',
    model?: string
  ): EmbeddingProvider | null {
    try {
      switch (name) {
        case 'deepseek': {
          const apiKey = process.env.DEEPSEEK_API_KEY;
          if (apiKey) {
            logger.info('DeepSeek embedding available');
            return new DeepSeekEmbedding(apiKey, undefined, model);
          }
          break;
        }

        case 'openai': {
          const apiKey = process.env.OPENAI_API_KEY;
          if (apiKey) {
            logger.info('OpenAI embedding available');
            return new OpenAIEmbedding(apiKey, undefined, model);
          }
          break;
        }

        case 'gemini': {
          const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
          if (apiKey) {
            logger.info('Gemini embedding available');
            return new GeminiEmbedding(apiKey, model);
          }
          break;
        }

        case 'local':
          return this.fallbackProvider;
      }
    } catch (error) {
      logger.warn(`Failed to create ${name} provider:`, error);
    }

    return null;
  }

  private async tryWithFallback<T>(
    operation: (provider: EmbeddingProvider) => Promise<T>
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let i = this.currentProviderIndex; i < this.fallbackChain.length; i++) {
      const provider = this.fallbackChain[i];
      const failures = this.failureCount.get(i) || 0;

      // Skip providers that have failed too many times
      if (failures >= this.maxFailures && i < this.fallbackChain.length - 1) {
        continue;
      }

      try {
        const result = await operation(provider);
        // Reset failure count on success
        this.failureCount.set(i, 0);
        // Update current provider if we found a working one
        this.currentProviderIndex = i;
        this.provider = provider;
        return result;
      } catch (error) {
        lastError = error as Error;
        const newFailures = failures + 1;
        this.failureCount.set(i, newFailures);

        logger.warn(
          `Provider ${i} failed (${newFailures}/${this.maxFailures}):`,
          (error as Error).message
        );

        // Move to next provider
        if (i < this.fallbackChain.length - 1) {
          logger.info(`Falling back to provider ${i + 1}`);
        }
      }
    }

    throw lastError || new Error('All embedding providers failed');
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<number[]> {
    // Check cache first
    if (this.cacheEnabled) {
      const cacheKey = this.getCacheKey(text);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const embedding = await this.tryWithFallback((provider) => provider.embed(text));

    // Cache the result
    if (this.cacheEnabled) {
      this.addToCache(text, embedding);
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Check cache for each text
    if (this.cacheEnabled) {
      for (let i = 0; i < texts.length; i++) {
        const cacheKey = this.getCacheKey(texts[i]);
        const cached = this.cache.get(cacheKey);
        if (cached) {
          results[i] = cached;
        } else {
          uncachedIndices.push(i);
          uncachedTexts.push(texts[i]);
        }
      }
    } else {
      uncachedIndices.push(...texts.map((_, i) => i));
      uncachedTexts.push(...texts);
    }

    // If all cached, return early
    if (uncachedTexts.length === 0) {
      return results;
    }

    // Batch embed uncached texts with fallback
    const embeddings = await this.tryWithFallback((provider) =>
      provider.embedBatch(uncachedTexts)
    );

    // Update results and cache
    for (let i = 0; i < uncachedIndices.length; i++) {
      const originalIndex = uncachedIndices[i];
      results[originalIndex] = embeddings[i];

      if (this.cacheEnabled) {
        this.addToCache(uncachedTexts[i], embeddings[i]);
      }
    }

    return results;
  }

  /**
   * Get the dimension of embeddings
   */
  getDimension(): number {
    return this.provider.getDimension();
  }

  /**
   * Get current provider type
   */
  getProviderType(): string {
    if (this.provider instanceof DeepSeekEmbedding) return 'deepseek';
    if (this.provider instanceof OpenAIEmbedding) return 'openai';
    if (this.provider instanceof GeminiEmbedding) return 'gemini';
    return 'local';
  }

  /**
   * Get fallback chain status
   */
  getFallbackStatus(): {
    currentProvider: string;
    availableProviders: string[];
    failureCounts: Record<string, number>;
  } {
    const providerNames = this.fallbackChain.map((p) => {
      if (p instanceof DeepSeekEmbedding) return 'deepseek';
      if (p instanceof OpenAIEmbedding) return 'openai';
      if (p instanceof GeminiEmbedding) return 'gemini';
      return 'local';
    });

    const failureCounts: Record<string, number> = {};
    for (let i = 0; i < providerNames.length; i++) {
      failureCounts[providerNames[i]] = this.failureCount.get(i) || 0;
    }

    return {
      currentProvider: this.getProviderType(),
      availableProviders: providerNames,
      failureCounts,
    };
  }

  /**
   * Reset failure counts to retry failed providers
   */
  resetFailureCounts(): void {
    this.failureCount.clear();
    this.currentProviderIndex = 0;
    this.provider = this.fallbackChain[0] || this.fallbackProvider;
    logger.info('Embedding provider failure counts reset');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hitRate: 0, // Would need to track hits/misses for this
    };
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(text: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `emb_${hash}_${text.length}`;
  }

  private addToCache(text: string, embedding: number[]): void {
    // Evict oldest if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(this.getCacheKey(text), embedding);
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let embeddingServiceInstance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingServiceInstance) {
    embeddingServiceInstance = new EmbeddingService({
      provider: 'deepseek', // Try DeepSeek first
      cacheEnabled: true,
    });
  }
  return embeddingServiceInstance;
}

export function initEmbeddingService(config?: Partial<EmbeddingConfig>): EmbeddingService {
  embeddingServiceInstance = new EmbeddingService(config);
  return embeddingServiceInstance;
}
