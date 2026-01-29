// ============================================================================
// Hybrid Search - Combines vector search and FTS with RRF fusion
// Provides robust search with Reciprocal Rank Fusion algorithm
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  LocalVectorStore,
  type LocalSearchResult,
  type FTSSearchResult,
  type LocalVectorMetadata,
} from './localVectorStore';
import { EmbeddingService, getEmbeddingService } from './embeddingService';

const logger = createLogger('HybridSearch');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface HybridSearchResult {
  id: string;
  content: string;
  metadata: LocalVectorMetadata;
  score: number;
  vectorScore?: number;
  ftsScore?: number;
  rrfScore: number;
}

export interface HybridSearchOptions {
  topK?: number;
  threshold?: number;
  filter?: Partial<LocalVectorMetadata>;
  vectorWeight?: number;
  ftsWeight?: number;
  rrfK?: number; // RRF parameter (default 60)
  useVectorSearch?: boolean;
  useFTSSearch?: boolean;
}

export interface SearchStats {
  vectorResults: number;
  ftsResults: number;
  mergedResults: number;
  searchTimeMs: number;
}

// ----------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ----------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion combines results from multiple retrieval methods
 * RRF(d) = sum( 1 / (k + rank(d)) ) for each result set
 * where k is a constant (typically 60)
 */
function computeRRFScores(
  vectorResults: Array<{ id: string; rank: number }>,
  ftsResults: Array<{ id: string; rank: number }>,
  k: number = 60,
  vectorWeight: number = 0.6,
  ftsWeight: number = 0.4
): Map<string, number> {
  const scores = new Map<string, number>();

  // Add vector search contribution
  for (const { id, rank } of vectorResults) {
    const rrfScore = vectorWeight / (k + rank);
    scores.set(id, (scores.get(id) || 0) + rrfScore);
  }

  // Add FTS contribution
  for (const { id, rank } of ftsResults) {
    const rrfScore = ftsWeight / (k + rank);
    scores.set(id, (scores.get(id) || 0) + rrfScore);
  }

  return scores;
}

// ----------------------------------------------------------------------------
// Hybrid Search Service
// ----------------------------------------------------------------------------

export class HybridSearchService {
  private vectorStore: LocalVectorStore;
  private embeddingService: EmbeddingService;

  constructor(vectorStore: LocalVectorStore, embeddingService?: EmbeddingService) {
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService || getEmbeddingService();
  }

  /**
   * Perform hybrid search combining vector and FTS results
   */
  async search(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<{
    results: HybridSearchResult[];
    stats: SearchStats;
  }> {
    const startTime = Date.now();
    const {
      topK = 10,
      threshold = 0.0,
      filter,
      vectorWeight = 0.6,
      ftsWeight = 0.4,
      rrfK = 60,
      useVectorSearch = true,
      useFTSSearch = true,
    } = options;

    // Fetch more results initially for better RRF fusion
    const fetchK = Math.max(topK * 2, 20);

    let vectorResults: LocalSearchResult[] = [];
    let ftsResults: FTSSearchResult[] = [];

    // Parallel search execution
    const searches: Promise<void>[] = [];

    if (useVectorSearch) {
      searches.push(
        (async () => {
          const queryEmbedding = await this.embeddingService.embed(query);
          vectorResults = this.vectorStore.search(
            new Float32Array(queryEmbedding),
            { topK: fetchK, threshold, filter }
          );
        })()
      );
    }

    if (useFTSSearch) {
      searches.push(
        (async () => {
          ftsResults = this.vectorStore.searchFTS(query, { topK: fetchK, filter });
        })()
      );
    }

    await Promise.all(searches);

    // Compute RRF scores
    const vectorRanked = vectorResults.map((r, i) => ({ id: r.id, rank: i + 1 }));
    const ftsRanked = ftsResults.map((r, i) => ({ id: r.id, rank: i + 1 }));

    const rrfScores = computeRRFScores(
      vectorRanked,
      ftsRanked,
      rrfK,
      vectorWeight,
      ftsWeight
    );

    // Build result map for deduplication
    const resultMap = new Map<
      string,
      {
        content: string;
        metadata: LocalVectorMetadata;
        vectorScore?: number;
        ftsScore?: number;
      }
    >();

    for (const r of vectorResults) {
      resultMap.set(r.id, {
        content: r.content,
        metadata: r.metadata,
        vectorScore: r.score,
      });
    }

    for (const r of ftsResults) {
      const existing = resultMap.get(r.id);
      if (existing) {
        // Normalize FTS rank to a score (lower rank = higher score)
        existing.ftsScore = 1 / (1 + Math.abs(r.rank));
      } else {
        resultMap.set(r.id, {
          content: r.content,
          metadata: r.metadata,
          ftsScore: 1 / (1 + Math.abs(r.rank)),
        });
      }
    }

    // Combine and sort results
    const hybridResults: HybridSearchResult[] = [];

    for (const [id, rrfScore] of rrfScores) {
      const data = resultMap.get(id);
      if (!data) continue;

      // Compute combined score
      const combinedScore =
        (data.vectorScore || 0) * vectorWeight +
        (data.ftsScore || 0) * ftsWeight;

      if (combinedScore >= threshold || rrfScore > 0) {
        hybridResults.push({
          id,
          content: data.content,
          metadata: data.metadata,
          score: combinedScore,
          vectorScore: data.vectorScore,
          ftsScore: data.ftsScore,
          rrfScore,
        });
      }
    }

    // Sort by RRF score (primary) and combined score (secondary)
    hybridResults.sort((a, b) => {
      const rrfDiff = b.rrfScore - a.rrfScore;
      if (Math.abs(rrfDiff) > 0.0001) return rrfDiff;
      return b.score - a.score;
    });

    const endTime = Date.now();

    return {
      results: hybridResults.slice(0, topK),
      stats: {
        vectorResults: vectorResults.length,
        ftsResults: ftsResults.length,
        mergedResults: hybridResults.length,
        searchTimeMs: endTime - startTime,
      },
    };
  }

  /**
   * Search with query expansion (adds related terms)
   */
  async searchWithExpansion(
    query: string,
    options: HybridSearchOptions & { expandQuery?: boolean } = {}
  ): Promise<{
    results: HybridSearchResult[];
    stats: SearchStats;
    expandedQuery?: string;
  }> {
    const { expandQuery = false, ...searchOptions } = options;

    if (!expandQuery) {
      const result = await this.search(query, searchOptions);
      return { ...result, expandedQuery: query };
    }

    // Simple query expansion: add common programming synonyms
    const expansions: Record<string, string[]> = {
      function: ['method', 'func', 'fn'],
      class: ['type', 'struct', 'interface'],
      error: ['exception', 'bug', 'issue'],
      test: ['spec', 'unittest', 'testing'],
      config: ['configuration', 'settings', 'options'],
      api: ['endpoint', 'route', 'handler'],
      database: ['db', 'store', 'repository'],
      async: ['asynchronous', 'await', 'promise'],
    };

    const terms = query.toLowerCase().split(/\s+/);
    const expanded = new Set(terms);

    for (const term of terms) {
      if (expansions[term]) {
        for (const exp of expansions[term]) {
          expanded.add(exp);
        }
      }
    }

    const expandedQuery = Array.from(expanded).join(' ');
    const result = await this.search(expandedQuery, searchOptions);

    return {
      ...result,
      expandedQuery,
    };
  }

  /**
   * Batch search for multiple queries
   */
  async searchBatch(
    queries: string[],
    options: HybridSearchOptions = {}
  ): Promise<Array<{ results: HybridSearchResult[]; stats: SearchStats }>> {
    const results = await Promise.all(
      queries.map((query) => this.search(query, options))
    );
    return results;
  }

  /**
   * Semantic similarity search (vector only)
   */
  async semanticSearch(
    query: string,
    options: Omit<HybridSearchOptions, 'useVectorSearch' | 'useFTSSearch'> = {}
  ): Promise<{
    results: HybridSearchResult[];
    stats: SearchStats;
  }> {
    return this.search(query, {
      ...options,
      useVectorSearch: true,
      useFTSSearch: false,
      vectorWeight: 1.0,
      ftsWeight: 0.0,
    });
  }

  /**
   * Keyword search (FTS only)
   */
  async keywordSearch(
    query: string,
    options: Omit<HybridSearchOptions, 'useVectorSearch' | 'useFTSSearch'> = {}
  ): Promise<{
    results: HybridSearchResult[];
    stats: SearchStats;
  }> {
    return this.search(query, {
      ...options,
      useVectorSearch: false,
      useFTSSearch: true,
      vectorWeight: 0.0,
      ftsWeight: 1.0,
    });
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let hybridSearchInstance: HybridSearchService | null = null;

export function getHybridSearchService(
  vectorStore: LocalVectorStore,
  embeddingService?: EmbeddingService
): HybridSearchService {
  if (!hybridSearchInstance) {
    hybridSearchInstance = new HybridSearchService(vectorStore, embeddingService);
  }
  return hybridSearchInstance;
}

export function createHybridSearchService(
  vectorStore: LocalVectorStore,
  embeddingService?: EmbeddingService
): HybridSearchService {
  return new HybridSearchService(vectorStore, embeddingService);
}
