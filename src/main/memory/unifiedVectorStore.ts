// ============================================================================
// Unified Vector Store - Single interface for local/cloud/hybrid storage
// Provides seamless switching between storage modes
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  LocalVectorStore,
  initLocalVectorStore,
  type LocalVectorDocument,
  type LocalVectorMetadata,
  type LocalSearchResult,
  type LocalVectorStoreConfig,
} from './localVectorStore';
import {
  VectorStore,
  getVectorStore,
  type SearchResult,
  type CloudSearchResult,
} from './vectorStore';
import {
  HybridSearchService,
  createHybridSearchService,
  type HybridSearchResult,
  type HybridSearchOptions,
} from './hybridSearch';
import { EmbeddingService, getEmbeddingService } from './embeddingService';

const logger = createLogger('UnifiedVectorStore');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type StorageMode = 'local' | 'cloud' | 'hybrid';

export interface UnifiedSearchResult {
  id: string;
  content: string;
  metadata: LocalVectorMetadata;
  score: number;
  source: 'local' | 'cloud';
  vectorScore?: number;
  ftsScore?: number;
}

export interface UnifiedDocument {
  id: string;
  content: string;
  metadata: LocalVectorMetadata;
  embedding?: number[] | Float32Array;
}

export interface UnifiedSearchOptions {
  topK?: number;
  threshold?: number;
  filter?: Partial<LocalVectorMetadata>;
  includeLocal?: boolean;
  includeCloud?: boolean;
  useFTS?: boolean;
  vectorWeight?: number;
  ftsWeight?: number;
}

export interface UnifiedVectorStoreConfig {
  mode: StorageMode;
  localConfig?: Partial<LocalVectorStoreConfig>;
  preferLocalSearch?: boolean;
  localSearchTimeoutMs?: number;
  cloudSearchTimeoutMs?: number;
  deduplicateResults?: boolean;
}

// ----------------------------------------------------------------------------
// Unified Vector Store
// ----------------------------------------------------------------------------

export class UnifiedVectorStore {
  private config: UnifiedVectorStoreConfig;
  private localStore: LocalVectorStore | null = null;
  private cloudStore: VectorStore | null = null;
  private hybridSearch: HybridSearchService | null = null;
  private embeddingService: EmbeddingService;
  private initialized = false;

  constructor(config?: Partial<UnifiedVectorStoreConfig>) {
    this.config = {
      mode: 'hybrid',
      preferLocalSearch: true,
      localSearchTimeoutMs: 5000,
      cloudSearchTimeoutMs: 10000,
      deduplicateResults: true,
      ...config,
    };
    this.embeddingService = getEmbeddingService();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize local store
      if (this.config.mode === 'local' || this.config.mode === 'hybrid') {
        this.localStore = await initLocalVectorStore(this.config.localConfig);
        this.hybridSearch = createHybridSearchService(
          this.localStore,
          this.embeddingService
        );
        logger.info('Local vector store initialized');
      }

      // Initialize cloud store
      if (this.config.mode === 'cloud' || this.config.mode === 'hybrid') {
        this.cloudStore = getVectorStore();
        await this.cloudStore.initialize();
        logger.info('Cloud vector store initialized');
      }

      this.initialized = true;
      logger.info(`UnifiedVectorStore initialized in ${this.config.mode} mode`);
    } catch (error) {
      logger.error('Failed to initialize UnifiedVectorStore:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Document Operations
  // --------------------------------------------------------------------------

  /**
   * Add or update a document
   */
  async upsert(doc: UnifiedDocument): Promise<void> {
    // Generate embedding if not provided
    let embedding = doc.embedding;
    if (!embedding) {
      embedding = await this.embeddingService.embed(doc.content);
    }

    const localDoc: LocalVectorDocument = {
      id: doc.id,
      content: doc.content,
      embedding: embedding instanceof Float32Array ? embedding : new Float32Array(embedding),
      metadata: {
        ...doc.metadata,
        createdAt: doc.metadata.createdAt || Date.now(),
        updatedAt: Date.now(),
      },
    };

    // Store in local
    if (this.localStore && (this.config.mode === 'local' || this.config.mode === 'hybrid')) {
      await this.localStore.upsert(localDoc);
    }

    // Store in cloud (async, non-blocking in hybrid mode)
    if (this.cloudStore && (this.config.mode === 'cloud' || this.config.mode === 'hybrid')) {
      // In hybrid mode, cloud sync can fail without breaking local
      try {
        await this.cloudStore.add(doc.content, {
          ...doc.metadata,
          createdAt: doc.metadata.createdAt || Date.now(),
        });
      } catch (error) {
        if (this.config.mode === 'cloud') {
          throw error;
        }
        logger.warn('Cloud upsert failed (continuing with local):', error);
      }
    }
  }

  /**
   * Batch upsert documents
   */
  async upsertBatch(docs: UnifiedDocument[]): Promise<void> {
    // Generate embeddings in batch for efficiency
    const textsWithoutEmbedding = docs
      .filter((d) => !d.embedding)
      .map((d) => d.content);

    let embeddings: number[][] = [];
    if (textsWithoutEmbedding.length > 0) {
      embeddings = await this.embeddingService.embedBatch(textsWithoutEmbedding);
    }

    let embeddingIndex = 0;
    for (const doc of docs) {
      const embedding = doc.embedding || embeddings[embeddingIndex++];
      await this.upsert({ ...doc, embedding });
    }
  }

  /**
   * Delete document by ID
   */
  delete(id: string): boolean {
    let deleted = false;

    if (this.localStore) {
      deleted = this.localStore.delete(id) || deleted;
    }

    if (this.cloudStore) {
      deleted = this.cloudStore.delete(id) || deleted;
    }

    return deleted;
  }

  /**
   * Delete documents by filter
   */
  deleteByFilter(filter: Partial<LocalVectorMetadata>): number {
    let count = 0;

    if (this.localStore) {
      count += this.localStore.deleteByFilter(filter);
    }

    if (this.cloudStore) {
      // Convert filter for cloud store
      count += this.cloudStore.deleteByMetadata({
        source: filter.source,
        projectPath: filter.projectPath,
        filePath: filter.filePath,
        sessionId: filter.sessionId,
      });
    }

    return count;
  }

  /**
   * Get document by ID
   */
  get(id: string): UnifiedDocument | null {
    // Try local first
    if (this.localStore) {
      const doc = this.localStore.get(id);
      if (doc) {
        return {
          id: doc.id,
          content: doc.content,
          metadata: doc.metadata,
          embedding: doc.embedding,
        };
      }
    }

    // Try cloud
    if (this.cloudStore) {
      const doc = this.cloudStore.get(id);
      if (doc) {
        return {
          id: doc.id,
          content: doc.content,
          metadata: {
            ...doc.metadata,
            updatedAt: doc.metadata.createdAt || Date.now(),
          },
          embedding: doc.embedding,
        };
      }
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  /**
   * Unified search across local and/or cloud stores
   */
  async search(
    query: string,
    options: UnifiedSearchOptions = {}
  ): Promise<UnifiedSearchResult[]> {
    const {
      topK = 10,
      threshold = 0.0,
      filter,
      includeLocal = true,
      includeCloud = this.config.mode !== 'local',
      useFTS = true,
      vectorWeight = 0.6,
      ftsWeight = 0.4,
    } = options;

    const results: UnifiedSearchResult[] = [];
    const searches: Promise<void>[] = [];

    // Local search (with hybrid FTS)
    if (includeLocal && this.hybridSearch && this.localStore) {
      searches.push(
        this.searchLocalWithTimeout(query, {
          topK: topK * 2, // Fetch more for merging
          threshold,
          filter,
          vectorWeight,
          ftsWeight: useFTS ? ftsWeight : 0,
          useVectorSearch: true,
          useFTSSearch: useFTS,
        }).then((localResults) => {
          for (const r of localResults) {
            results.push({
              id: r.id,
              content: r.content,
              metadata: r.metadata,
              score: r.score,
              source: 'local',
              vectorScore: r.vectorScore,
              ftsScore: r.ftsScore,
            });
          }
        })
      );
    }

    // Cloud search
    if (includeCloud && this.cloudStore && this.cloudStore.isCloudAvailable()) {
      searches.push(
        this.searchCloudWithTimeout(query, {
          topK: topK * 2,
          threshold,
          projectPath: filter?.projectPath || null,
        }).then((cloudResults) => {
          for (const r of cloudResults) {
            results.push({
              id: r.id,
              content: r.content,
              metadata: {
                source: r.source,
                projectPath: r.projectPath || undefined,
                filePath: r.filePath || undefined,
                sessionId: r.sessionId || undefined,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
              score: r.similarity,
              source: 'cloud',
            });
          }
        })
      );
    }

    await Promise.allSettled(searches);

    // Deduplicate and merge results
    if (this.config.deduplicateResults) {
      return this.deduplicateResults(results, topK);
    }

    // Sort by score and return top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private async searchLocalWithTimeout(
    query: string,
    options: HybridSearchOptions
  ): Promise<HybridSearchResult[]> {
    if (!this.hybridSearch) return [];

    try {
      const timeoutPromise = new Promise<{ results: HybridSearchResult[] }>((_, reject) => {
        setTimeout(
          () => reject(new Error('Local search timeout')),
          this.config.localSearchTimeoutMs
        );
      });

      const searchPromise = this.hybridSearch.search(query, options);
      const result = await Promise.race([searchPromise, timeoutPromise]);
      return result.results;
    } catch (error) {
      logger.warn('Local search failed:', error);
      return [];
    }
  }

  private async searchCloudWithTimeout(
    query: string,
    options: { topK: number; threshold: number; projectPath: string | null }
  ): Promise<CloudSearchResult[]> {
    if (!this.cloudStore) return [];

    try {
      const timeoutPromise = new Promise<CloudSearchResult[]>((_, reject) => {
        setTimeout(
          () => reject(new Error('Cloud search timeout')),
          this.config.cloudSearchTimeoutMs
        );
      });

      const searchPromise = this.cloudStore.searchCloud(query, options);
      return await Promise.race([searchPromise, timeoutPromise]);
    } catch (error) {
      logger.warn('Cloud search failed:', error);
      return [];
    }
  }

  private deduplicateResults(
    results: UnifiedSearchResult[],
    topK: number
  ): UnifiedSearchResult[] {
    const seen = new Map<string, UnifiedSearchResult>();

    for (const result of results) {
      // Use content hash for deduplication
      const key = result.content.slice(0, 200).toLowerCase();

      const existing = seen.get(key);
      if (!existing || result.score > existing.score) {
        // Prefer higher score, or local over cloud
        if (!existing || result.source === 'local') {
          seen.set(key, result);
        }
      }
    }

    const deduplicated = Array.from(seen.values());
    deduplicated.sort((a, b) => b.score - a.score);
    return deduplicated.slice(0, topK);
  }

  // --------------------------------------------------------------------------
  // Specialized Search Methods
  // --------------------------------------------------------------------------

  /**
   * Search for code files
   */
  async searchCode(
    query: string,
    projectPath?: string,
    topK: number = 10
  ): Promise<UnifiedSearchResult[]> {
    return this.search(query, {
      topK,
      filter: {
        source: 'file',
        projectPath,
      },
      useFTS: true,
    });
  }

  /**
   * Search for conversations
   */
  async searchConversations(
    query: string,
    sessionId?: string,
    topK: number = 10
  ): Promise<UnifiedSearchResult[]> {
    return this.search(query, {
      topK,
      filter: {
        source: 'conversation',
        sessionId,
      },
      useFTS: true,
    });
  }

  /**
   * Search knowledge base
   */
  async searchKnowledge(
    query: string,
    category?: string,
    topK: number = 10
  ): Promise<UnifiedSearchResult[]> {
    return this.search(query, {
      topK,
      filter: {
        source: 'knowledge',
        category,
      },
      useFTS: true,
    });
  }

  // --------------------------------------------------------------------------
  // RAG Context
  // --------------------------------------------------------------------------

  /**
   * Get RAG context for a query
   */
  async getRAGContext(
    query: string,
    options: {
      maxTokens?: number;
      sources?: ('file' | 'conversation' | 'knowledge')[];
      projectPath?: string;
    } = {}
  ): Promise<{
    context: string;
    sources: Array<{ type: string; path?: string; score: number; source: 'local' | 'cloud' }>;
  }> {
    const { maxTokens = 2000, sources = ['file', 'knowledge'], projectPath } = options;

    const allResults: UnifiedSearchResult[] = [];

    for (const source of sources) {
      const results = await this.search(query, {
        topK: 5,
        filter: {
          source,
          projectPath,
        },
      });
      allResults.push(...results);
    }

    // Sort by score
    allResults.sort((a, b) => b.score - a.score);

    // Build context string
    let context = '';
    let tokenCount = 0;
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);
    const sourceAttribution: Array<{
      type: string;
      path?: string;
      score: number;
      source: 'local' | 'cloud';
    }> = [];

    for (const result of allResults) {
      const docTokens = estimateTokens(result.content);
      if (tokenCount + docTokens > maxTokens) break;

      const sourceInfo = result.metadata.filePath
        ? `[${result.metadata.filePath}]`
        : `[${result.metadata.source}]`;

      context += `${sourceInfo}\n${result.content}\n\n`;
      tokenCount += docTokens;

      sourceAttribution.push({
        type: result.metadata.source,
        path: result.metadata.filePath || result.metadata.projectPath,
        score: result.score,
        source: result.source,
      });
    }

    return {
      context: context.trim(),
      sources: sourceAttribution,
    };
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get storage statistics
   */
  getStats(): {
    mode: StorageMode;
    local: { totalDocuments: number; bySource: Record<string, number> } | null;
    cloud: { available: boolean; documentCount: number } | null;
  } {
    let localStats = null;
    if (this.localStore) {
      const stats = this.localStore.getStats();
      localStats = {
        totalDocuments: stats.totalDocuments,
        bySource: stats.bySource,
      };
    }

    let cloudStats = null;
    if (this.cloudStore) {
      const stats = this.cloudStore.getStats();
      cloudStats = {
        available: this.cloudStore.isCloudAvailable(),
        documentCount: stats.documentCount,
      };
    }

    return {
      mode: this.config.mode,
      local: localStats,
      cloud: cloudStats,
    };
  }

  /**
   * Check if document exists by content hash
   */
  existsByHash(contentHash: string): boolean {
    if (this.localStore) {
      return this.localStore.existsByHash(contentHash);
    }
    return false;
  }

  /**
   * Get document ID by content hash
   */
  getIdByHash(contentHash: string): string | null {
    if (this.localStore) {
      return this.localStore.getIdByHash(contentHash);
    }
    return null;
  }

  /**
   * Clear all data
   */
  clear(): void {
    if (this.localStore) {
      this.localStore.clear();
    }
    if (this.cloudStore) {
      this.cloudStore.clear();
    }
  }

  /**
   * Close connections
   */
  close(): void {
    if (this.localStore) {
      this.localStore.close();
    }
    this.initialized = false;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get current storage mode
   */
  getMode(): StorageMode {
    return this.config.mode;
  }

  /**
   * Set storage mode
   */
  async setMode(mode: StorageMode): Promise<void> {
    if (mode === this.config.mode) return;

    this.config.mode = mode;
    this.initialized = false;
    await this.initialize();
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let unifiedVectorStoreInstance: UnifiedVectorStore | null = null;

export function getUnifiedVectorStore(): UnifiedVectorStore {
  if (!unifiedVectorStoreInstance) {
    unifiedVectorStoreInstance = new UnifiedVectorStore();
  }
  return unifiedVectorStoreInstance;
}

export async function initUnifiedVectorStore(
  config?: Partial<UnifiedVectorStoreConfig>
): Promise<UnifiedVectorStore> {
  if (config) {
    unifiedVectorStoreInstance = new UnifiedVectorStore(config);
  } else {
    unifiedVectorStoreInstance = getUnifiedVectorStore();
  }
  await unifiedVectorStoreInstance.initialize();
  return unifiedVectorStoreInstance;
}
