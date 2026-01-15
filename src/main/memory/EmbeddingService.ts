// ============================================================================
// Embedding Service - Advanced embedding with API support
// Supports DeepSeek, OpenAI APIs with local fallback
// ============================================================================

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface EmbeddingConfig {
  provider: 'deepseek' | 'openai' | 'local';
  model?: string;
  dimension: number;
  batchSize: number;
  cacheEnabled: boolean;
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
// Embedding Service (with caching and auto-fallback)
// ----------------------------------------------------------------------------

export class EmbeddingService {
  private provider: EmbeddingProvider;
  private fallbackProvider: LocalEmbedding;
  private cache: Map<string, number[]> = new Map();
  private cacheEnabled: boolean;
  private maxCacheSize: number = 10000;

  constructor(config?: Partial<EmbeddingConfig>) {
    const defaultConfig: EmbeddingConfig = {
      provider: 'local',
      dimension: 384,
      batchSize: 100,
      cacheEnabled: true,
    };

    const finalConfig = { ...defaultConfig, ...config };
    this.cacheEnabled = finalConfig.cacheEnabled;
    this.fallbackProvider = new LocalEmbedding(finalConfig.dimension);

    // Initialize provider based on config
    this.provider = this.initializeProvider(finalConfig);
  }

  private initializeProvider(config: EmbeddingConfig): EmbeddingProvider {
    try {
      // Read API keys from environment variables
      switch (config.provider) {
        case 'deepseek': {
          const apiKey = process.env.DEEPSEEK_API_KEY;
          if (apiKey) {
            console.log('[EmbeddingService] Using DeepSeek embedding API');
            return new DeepSeekEmbedding(apiKey, undefined, config.model);
          }
          break;
        }

        case 'openai': {
          const apiKey = process.env.OPENAI_API_KEY;
          if (apiKey) {
            console.log('[EmbeddingService] Using OpenAI embedding API');
            return new OpenAIEmbedding(apiKey, undefined, config.model);
          }
          break;
        }
      }
    } catch (error) {
      console.warn('[EmbeddingService] Failed to initialize API provider:', error);
    }

    console.log('[EmbeddingService] Using local embedding (TF-IDF hash)');
    return this.fallbackProvider;
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

    try {
      const embedding = await this.provider.embed(text);

      // Cache the result
      if (this.cacheEnabled) {
        this.addToCache(text, embedding);
      }

      return embedding;
    } catch (error) {
      console.warn('[EmbeddingService] Provider failed, using fallback:', error);
      return this.fallbackProvider.embed(text);
    }
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

    try {
      // Batch embed uncached texts
      const embeddings = await this.provider.embedBatch(uncachedTexts);

      // Update results and cache
      for (let i = 0; i < uncachedIndices.length; i++) {
        const originalIndex = uncachedIndices[i];
        results[originalIndex] = embeddings[i];

        if (this.cacheEnabled) {
          this.addToCache(uncachedTexts[i], embeddings[i]);
        }
      }
    } catch (error) {
      console.warn('[EmbeddingService] Provider batch failed, using fallback:', error);

      // Fallback for uncached texts
      const fallbackEmbeddings = await this.fallbackProvider.embedBatch(uncachedTexts);
      for (let i = 0; i < uncachedIndices.length; i++) {
        results[uncachedIndices[i]] = fallbackEmbeddings[i];
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
    return 'local';
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
