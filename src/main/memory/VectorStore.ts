// ============================================================================
// Vector Store - 向量数据库实现（长期记忆）
// Enhanced with API embedding support (DeepSeek/OpenAI)
// ============================================================================

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getEmbeddingService, type EmbeddingService } from './EmbeddingService';
import {
  getSupabase,
  isSupabaseInitialized,
  type VectorMatchResult,
} from '../services/SupabaseService';
import { getAuthService } from '../services/AuthService';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface VectorDocumentMetadata {
  source: string; // 来源：file, conversation, knowledge
  projectPath?: string;
  filePath?: string;
  sessionId?: string;
  createdAt?: number;
  [key: string]: unknown;
}

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: VectorDocumentMetadata & { createdAt: number };
}

export interface SearchResult {
  document: VectorDocument;
  score: number; // 相似度分数 (0-1)
  distance: number; // 距离 (越小越相似)
}

// Exported for MemorySearch tool
export interface SearchResultExport {
  content: string;
  score: number;
  metadata: VectorDocumentMetadata & { createdAt: number };
}

// Cloud search result type
export interface CloudSearchResult {
  id: string;
  content: string;
  source: string;
  projectPath: string | null;
  filePath: string | null;
  sessionId: string | null;
  similarity: number;
}

// Hybrid search options (local + cloud)
export interface HybridSearchOptions {
  topK?: number;
  threshold?: number;
  filter?: Partial<VectorDocument['metadata']>;
  includeCloud?: boolean;      // Whether to search cloud (default: true if authenticated)
  projectPath?: string;        // Filter by project path
  crossProject?: boolean;      // Search across all projects (cloud only)
}

export interface VectorStoreConfig {
  embeddingDimension: number;
  maxDocuments: number;
  persistPath: string;
  useApiEmbedding?: boolean;
}

// ----------------------------------------------------------------------------
// Vector Store
// ----------------------------------------------------------------------------

export class VectorStore {
  private config: VectorStoreConfig;
  private documents: Map<string, VectorDocument> = new Map();
  private embeddingService: EmbeddingService | null = null;
  private dirty: boolean = false;

  constructor(config?: Partial<VectorStoreConfig>) {
    const userDataPath = app?.getPath?.('userData') || process.cwd();

    this.config = {
      embeddingDimension: 384,
      maxDocuments: 10000,
      persistPath: path.join(userDataPath, 'vector-store.json'),
      useApiEmbedding: true, // Default to using API embedding
      ...config,
    };
  }

  /**
   * Get embedding service (lazy initialization)
   */
  private getEmbedding(): EmbeddingService {
    if (!this.embeddingService) {
      this.embeddingService = getEmbeddingService();
    }
    return this.embeddingService;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.load();
  }

  // --------------------------------------------------------------------------
  // Document Management
  // --------------------------------------------------------------------------

  /**
   * 添加文档
   */
  async add(
    content: string,
    metadata: VectorDocumentMetadata
  ): Promise<string> {
    const id = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const embedding = await this.getEmbedding().embed(content);

    const document: VectorDocument = {
      id,
      content,
      embedding,
      metadata: {
        ...metadata,
        createdAt: metadata.createdAt || Date.now(),
      },
    };

    // 检查是否超过最大文档数
    if (this.documents.size >= this.config.maxDocuments) {
      this.evictOldest();
    }

    this.documents.set(id, document);
    this.dirty = true;

    return id;
  }

  /**
   * 批量添加文档
   */
  async addBatch(
    items: Array<{ content: string; metadata: VectorDocumentMetadata }>
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const item of items) {
      const id = await this.add(item.content, item.metadata);
      ids.push(id);
    }

    return ids;
  }

  /**
   * 删除文档
   */
  delete(id: string): boolean {
    const deleted = this.documents.delete(id);
    if (deleted) {
      this.dirty = true;
    }
    return deleted;
  }

  /**
   * 按条件删除
   */
  deleteByMetadata(filter: Partial<VectorDocument['metadata']>): number {
    let deleted = 0;

    for (const [id, doc] of this.documents.entries()) {
      let match = true;
      for (const [key, value] of Object.entries(filter)) {
        if (doc.metadata[key] !== value) {
          match = false;
          break;
        }
      }

      if (match) {
        this.documents.delete(id);
        deleted++;
      }
    }

    if (deleted > 0) {
      this.dirty = true;
    }

    return deleted;
  }

  /**
   * 获取文档
   */
  get(id: string): VectorDocument | undefined {
    return this.documents.get(id);
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  /**
   * 相似度搜索 (异步版本)
   */
  async searchAsync(
    query: string,
    options: {
      topK?: number;
      threshold?: number;
      filter?: Partial<VectorDocument['metadata']>;
    } = {}
  ): Promise<SearchResult[]> {
    const { topK = 5, threshold = 0.0, filter } = options;

    const queryEmbedding = await this.getEmbedding().embed(query);
    return this.searchWithEmbedding(queryEmbedding, options);
  }

  /**
   * 相似度搜索 (同步版本，使用缓存的 embedding)
   * 注意：此方法使用简单的本地 embedding 作为 fallback
   */
  search(
    query: string,
    options: {
      topK?: number;
      threshold?: number;
      filter?: Partial<VectorDocument['metadata']>;
    } = {}
  ): SearchResult[] {
    const { topK = 5, threshold = 0.0, filter } = options;

    // Use synchronous local embedding for immediate search
    const queryEmbedding = this.localEmbed(query);
    return this.searchWithEmbedding(queryEmbedding, options);
  }

  /**
   * 使用预计算的 embedding 进行搜索
   */
  private searchWithEmbedding(
    queryEmbedding: number[],
    options: {
      topK?: number;
      threshold?: number;
      filter?: Partial<VectorDocument['metadata']>;
    } = {}
  ): SearchResult[] {
    const { topK = 5, threshold = 0.0, filter } = options;
    const results: SearchResult[] = [];

    for (const doc of this.documents.values()) {
      // 应用元数据过滤
      if (filter) {
        let match = true;
        for (const [key, value] of Object.entries(filter)) {
          if (doc.metadata[key] !== value) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      const distance = this.cosineSimilarity(queryEmbedding, doc.embedding);
      const score = (distance + 1) / 2; // 转换到 0-1 范围

      if (score >= threshold) {
        results.push({ document: doc, score, distance });
      }
    }

    // 按分数排序并取 top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * 混合搜索（向量 + 关键词）
   */
  hybridSearch(
    query: string,
    options: {
      topK?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      filter?: Partial<VectorDocument['metadata']>;
    } = {}
  ): SearchResult[] {
    const {
      topK = 5,
      vectorWeight = 0.7,
      keywordWeight = 0.3,
      filter,
    } = options;

    const queryTerms = query.toLowerCase().split(/\s+/);
    const queryEmbedding = this.localEmbed(query);
    const results: SearchResult[] = [];

    for (const doc of this.documents.values()) {
      // 应用元数据过滤
      if (filter) {
        let match = true;
        for (const [key, value] of Object.entries(filter)) {
          if (doc.metadata[key] !== value) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      // 向量相似度
      const vectorSim = this.cosineSimilarity(queryEmbedding, doc.embedding);
      const vectorScore = (vectorSim + 1) / 2;

      // 关键词匹配
      const docTerms = doc.content.toLowerCase().split(/\s+/);
      let keywordMatches = 0;
      for (const term of queryTerms) {
        if (docTerms.includes(term)) {
          keywordMatches++;
        }
      }
      const keywordScore = queryTerms.length > 0 ? keywordMatches / queryTerms.length : 0;

      // 混合分数
      const score = vectorWeight * vectorScore + keywordWeight * keywordScore;

      results.push({
        document: doc,
        score,
        distance: vectorSim,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // --------------------------------------------------------------------------
  // Cloud Search (Supabase pgvector)
  // --------------------------------------------------------------------------

  /**
   * 检查云端搜索是否可用
   */
  isCloudAvailable(): boolean {
    if (!isSupabaseInitialized()) return false;
    const user = getAuthService().getCurrentUser();
    return user !== null;
  }

  /**
   * 云端向量搜索 (使用 Supabase match_vectors RPC)
   *
   * @param query - 搜索查询文本
   * @param options - 搜索选项
   * @returns 云端搜索结果数组
   */
  async searchCloud(
    query: string,
    options: {
      topK?: number;
      threshold?: number;
      projectPath?: string | null;
    } = {}
  ): Promise<CloudSearchResult[]> {
    const { topK = 10, threshold = 0.7, projectPath = null } = options;

    // Check if cloud is available
    if (!this.isCloudAvailable()) {
      console.log('[VectorStore] Cloud search not available (not authenticated)');
      return [];
    }

    try {
      const user = getAuthService().getCurrentUser();
      if (!user) return [];

      // Generate embedding for query
      const queryEmbedding = await this.getEmbedding().embed(query);

      // Ensure embedding dimension matches Supabase (1024 for DeepSeek)
      const normalizedEmbedding = this.normalizeEmbeddingDimension(queryEmbedding, 1024);

      // Call Supabase RPC function
      const supabase = getSupabase();
      const { data, error } = await supabase.rpc('match_vectors', {
        query_embedding: normalizedEmbedding,
        match_user_id: user.id,
        match_project_path: projectPath,
        match_threshold: threshold,
        match_count: topK,
      });

      if (error) {
        console.error('[VectorStore] Cloud search error:', error);
        return [];
      }

      // Map results
      return (data || []).map((item: VectorMatchResult) => ({
        id: item.id,
        content: item.content,
        source: item.source,
        projectPath: item.project_path,
        filePath: item.file_path,
        sessionId: item.session_id,
        similarity: item.similarity,
      }));
    } catch (error) {
      console.error('[VectorStore] Cloud search failed:', error);
      return [];
    }
  }

  /**
   * 混合搜索：本地优先 + 云端补充
   *
   * 策略：
   * 1. 先快速搜索本地向量库
   * 2. 如果本地结果不足或分数较低，补充云端搜索
   * 3. 合并去重，按相似度排序
   *
   * @param query - 搜索查询
   * @param options - 混合搜索选项
   * @returns 合并后的搜索结果
   */
  async searchHybridAsync(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      topK = 5,
      threshold = 0.5,
      filter,
      includeCloud = true,
      projectPath,
      crossProject = false,
    } = options;

    // 1. 先搜索本地
    const localFilter = projectPath ? { ...filter, projectPath } : filter;
    const localResults = await this.searchAsync(query, {
      topK: topK * 2, // 多取一些用于合并
      threshold,
      filter: localFilter,
    });

    // 2. 如果不需要云端搜索，直接返回本地结果
    if (!includeCloud || !this.isCloudAvailable()) {
      return localResults.slice(0, topK);
    }

    // 3. 判断是否需要云端搜索
    const needCloud =
      localResults.length < topK ||
      (localResults.length > 0 && localResults[0].score < 0.8);

    if (!needCloud) {
      return localResults.slice(0, topK);
    }

    // 4. 云端搜索
    const cloudProjectPath = crossProject ? null : projectPath;
    const cloudResults = await this.searchCloud(query, {
      topK: topK * 2,
      threshold,
      projectPath: cloudProjectPath,
    });

    // 5. 合并结果
    const mergedResults = this.mergeSearchResults(localResults, cloudResults, topK);

    return mergedResults;
  }

  /**
   * 合并本地和云端搜索结果
   */
  private mergeSearchResults(
    localResults: SearchResult[],
    cloudResults: CloudSearchResult[],
    topK: number
  ): SearchResult[] {
    // 将云端结果转换为统一格式
    const convertedCloud: SearchResult[] = cloudResults.map((cr) => ({
      document: {
        id: cr.id,
        content: cr.content,
        embedding: [], // 云端结果不包含 embedding
        metadata: {
          source: cr.source,
          projectPath: cr.projectPath || undefined,
          filePath: cr.filePath || undefined,
          sessionId: cr.sessionId || undefined,
          createdAt: Date.now(),
          fromCloud: true, // 标记为云端来源
        },
      },
      score: cr.similarity,
      distance: 1 - cr.similarity,
    }));

    // 合并并去重（按 content 去重）
    const seenContent = new Set<string>();
    const merged: SearchResult[] = [];

    // 先加本地结果
    for (const result of localResults) {
      const key = result.document.content.slice(0, 200);
      if (!seenContent.has(key)) {
        seenContent.add(key);
        merged.push(result);
      }
    }

    // 再加云端结果
    for (const result of convertedCloud) {
      const key = result.document.content.slice(0, 200);
      if (!seenContent.has(key)) {
        seenContent.add(key);
        merged.push(result);
      }
    }

    // 按分数排序并取 topK
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }

  /**
   * 标准化 embedding 维度
   * 如果维度不匹配，进行截断或填充
   */
  private normalizeEmbeddingDimension(embedding: number[], targetDim: number): number[] {
    if (embedding.length === targetDim) {
      return embedding;
    }

    if (embedding.length > targetDim) {
      // 截断
      return embedding.slice(0, targetDim);
    }

    // 填充 (用 0 填充)
    const padded = [...embedding];
    while (padded.length < targetDim) {
      padded.push(0);
    }
    return padded;
  }

  /**
   * 简单的本地嵌入 (用于同步搜索)
   * 使用 TF-IDF 风格的哈希
   */
  private localEmbed(text: string): number[] {
    const dimension = 384;
    const vector = new Array(dimension).fill(0);
    const tokens = text.toLowerCase().split(/\s+/);

    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        const char = token.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      const index = Math.abs(hash) % dimension;
      vector[index] += 1;
    }

    // 归一化
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map((v) => v / magnitude);
  }

  // --------------------------------------------------------------------------
  // Project Context
  // --------------------------------------------------------------------------

  /**
   * 为项目添加代码文件
   */
  async indexFile(
    projectPath: string,
    filePath: string,
    content: string
  ): Promise<string> {
    // 分块处理大文件
    const chunks = this.chunkText(content, 1000, 100);
    const ids: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const id = await this.add(chunks[i], {
        source: 'file',
        projectPath,
        filePath,
        chunkIndex: i,
        totalChunks: chunks.length,
      });
      ids.push(id);
    }

    return ids[0]; // 返回第一个块的 ID
  }

  /**
   * 为项目搜索相关代码
   */
  searchProject(
    projectPath: string,
    query: string,
    topK: number = 5
  ): SearchResult[] {
    return this.search(query, {
      topK,
      filter: { projectPath, source: 'file' },
    });
  }

  // --------------------------------------------------------------------------
  // Conversation Memory
  // --------------------------------------------------------------------------

  /**
   * 保存对话片段
   */
  async saveConversation(
    sessionId: string,
    content: string,
    role: string
  ): Promise<string> {
    return this.add(content, {
      source: 'conversation',
      sessionId,
      role,
    });
  }

  /**
   * 搜索相关对话
   */
  searchConversations(
    query: string,
    sessionId?: string,
    topK: number = 5
  ): SearchResult[] {
    const filter: Partial<VectorDocument['metadata']> = { source: 'conversation' };
    if (sessionId) {
      filter.sessionId = sessionId;
    }

    return this.search(query, { topK, filter });
  }

  // --------------------------------------------------------------------------
  // Knowledge Base
  // --------------------------------------------------------------------------

  /**
   * 添加知识条目
   */
  async addKnowledge(
    content: string,
    category: string,
    projectPath?: string
  ): Promise<string> {
    return this.add(content, {
      source: 'knowledge',
      category,
      projectPath,
    });
  }

  /**
   * 搜索知识库
   */
  searchKnowledge(
    query: string,
    category?: string,
    topK: number = 5
  ): SearchResult[] {
    const filter: Partial<VectorDocument['metadata']> = { source: 'knowledge' };
    if (category) {
      filter.category = category;
    }

    return this.search(query, { topK, filter });
  }

  // --------------------------------------------------------------------------
  // RAG (Retrieval Augmented Generation)
  // --------------------------------------------------------------------------

  /**
   * 获取 RAG 上下文 (同步版本，仅本地)
   */
  getRAGContext(
    query: string,
    options: {
      maxTokens?: number;
      sources?: ('file' | 'conversation' | 'knowledge')[];
      projectPath?: string;
    } = {}
  ): string {
    const { maxTokens = 2000, sources = ['file', 'knowledge'], projectPath } = options;

    const allResults: SearchResult[] = [];

    for (const source of sources) {
      const filter: Partial<VectorDocument['metadata']> = { source };
      if (projectPath) {
        filter.projectPath = projectPath;
      }

      const results = this.search(query, { topK: 3, filter });
      allResults.push(...results);
    }

    // 按分数排序
    allResults.sort((a, b) => b.score - a.score);

    // 构建上下文
    let context = '';
    let tokenCount = 0;
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    for (const result of allResults) {
      const docTokens = estimateTokens(result.document.content);
      if (tokenCount + docTokens > maxTokens) break;

      const sourceInfo = result.document.metadata.filePath
        ? `[${result.document.metadata.filePath}]`
        : `[${result.document.metadata.source}]`;

      context += `${sourceInfo}\n${result.document.content}\n\n`;
      tokenCount += docTokens;
    }

    return context.trim();
  }

  /**
   * 获取增强 RAG 上下文 (异步版本，支持云端搜索)
   *
   * 这是主要的 RAG 方法，支持：
   * - 本地向量搜索
   * - 云端 pgvector 搜索
   * - 跨项目知识检索
   */
  async getEnhancedRAGContext(
    query: string,
    options: {
      maxTokens?: number;
      sources?: ('file' | 'conversation' | 'knowledge')[];
      projectPath?: string;
      includeCloud?: boolean;
      crossProject?: boolean;
    } = {}
  ): Promise<{
    context: string;
    sources: Array<{
      type: string;
      path?: string;
      score: number;
      fromCloud: boolean;
    }>;
  }> {
    const {
      maxTokens = 2000,
      sources = ['file', 'knowledge'],
      projectPath,
      includeCloud = true,
      crossProject = false,
    } = options;

    const allResults: SearchResult[] = [];
    const sourceAttribution: Array<{
      type: string;
      path?: string;
      score: number;
      fromCloud: boolean;
    }> = [];

    // 1. 本地搜索各来源
    for (const source of sources) {
      const filter: Partial<VectorDocument['metadata']> = { source };
      if (projectPath) {
        filter.projectPath = projectPath;
      }

      const results = await this.searchAsync(query, { topK: 3, filter });
      allResults.push(...results);
    }

    // 2. 云端搜索（如果启用）
    if (includeCloud && this.isCloudAvailable()) {
      const cloudProjectPath = crossProject ? null : projectPath;
      const cloudResults = await this.searchCloud(query, {
        topK: 5,
        threshold: 0.6,
        projectPath: cloudProjectPath,
      });

      // 转换并添加云端结果
      for (const cr of cloudResults) {
        // 避免与本地结果重复
        const isDuplicate = allResults.some(
          (r) => r.document.content.slice(0, 200) === cr.content.slice(0, 200)
        );

        if (!isDuplicate) {
          allResults.push({
            document: {
              id: cr.id,
              content: cr.content,
              embedding: [],
              metadata: {
                source: cr.source,
                projectPath: cr.projectPath || undefined,
                filePath: cr.filePath || undefined,
                sessionId: cr.sessionId || undefined,
                createdAt: Date.now(),
                fromCloud: true,
              },
            },
            score: cr.similarity,
            distance: 1 - cr.similarity,
          });
        }
      }
    }

    // 3. 按分数排序
    allResults.sort((a, b) => b.score - a.score);

    // 4. 构建上下文
    let context = '';
    let tokenCount = 0;
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    for (const result of allResults) {
      const docTokens = estimateTokens(result.document.content);
      if (tokenCount + docTokens > maxTokens) break;

      const fromCloud = result.document.metadata.fromCloud === true;
      const sourceInfo = result.document.metadata.filePath
        ? `[${result.document.metadata.filePath}${fromCloud ? ' (cloud)' : ''}]`
        : `[${result.document.metadata.source}${fromCloud ? ' (cloud)' : ''}]`;

      context += `${sourceInfo}\n${result.document.content}\n\n`;
      tokenCount += docTokens;

      // 记录来源归因
      sourceAttribution.push({
        type: result.document.metadata.source,
        path: result.document.metadata.filePath || result.document.metadata.projectPath,
        score: result.score,
        fromCloud,
      });
    }

    return {
      context: context.trim(),
      sources: sourceAttribution,
    };
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /**
   * 保存到文件
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const data = {
      version: 1,
      documents: Array.from(this.documents.values()),
    };

    const dir = path.dirname(this.config.persistPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.config.persistPath, JSON.stringify(data));
    this.dirty = false;
  }

  /**
   * 从文件加载
   */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(this.config.persistPath)) {
        return;
      }

      const data = JSON.parse(fs.readFileSync(this.config.persistPath, 'utf-8'));

      if (data.documents) {
        for (const doc of data.documents) {
          this.documents.set(doc.id, doc);
        }
      }
    } catch (error) {
      console.error('Failed to load vector store:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * 文本分块
   */
  private chunkText(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start = end - overlap;

      if (start >= text.length - overlap) break;
    }

    return chunks;
  }

  /**
   * 淘汰最旧的文档
   */
  private evictOldest(): void {
    let oldest: VectorDocument | null = null;

    for (const doc of this.documents.values()) {
      if (!oldest || doc.metadata.createdAt < oldest.metadata.createdAt) {
        oldest = doc;
      }
    }

    if (oldest) {
      this.documents.delete(oldest.id);
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    documentCount: number;
    bySource: Record<string, number>;
    byProject: Record<string, number>;
    embeddingProvider: string;
    embeddingDimension: number;
  } {
    const bySource: Record<string, number> = {};
    const byProject: Record<string, number> = {};

    for (const doc of this.documents.values()) {
      const source = doc.metadata.source;
      bySource[source] = (bySource[source] || 0) + 1;

      if (doc.metadata.projectPath) {
        const proj = doc.metadata.projectPath;
        byProject[proj] = (byProject[proj] || 0) + 1;
      }
    }

    const embedding = this.getEmbedding();

    return {
      documentCount: this.documents.size,
      bySource,
      byProject,
      embeddingProvider: embedding.getProviderType(),
      embeddingDimension: embedding.getDimension(),
    };
  }

  /**
   * 清空所有数据
   */
  clear(): void {
    this.documents.clear();
    this.dirty = true;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let vectorStoreInstance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!vectorStoreInstance) {
    vectorStoreInstance = new VectorStore();
  }
  return vectorStoreInstance;
}

export async function initVectorStore(config?: Partial<VectorStoreConfig>): Promise<VectorStore> {
  if (config) {
    vectorStoreInstance = new VectorStore(config);
  } else {
    vectorStoreInstance = getVectorStore();
  }
  await vectorStoreInstance.initialize();
  return vectorStoreInstance;
}
