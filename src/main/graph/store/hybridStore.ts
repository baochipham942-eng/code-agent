/**
 * HybridStore - 向量存储 + 图存储的混合检索桥接层
 *
 * 职责：
 * 1. 原子性地在向量库和图库中创建/更新实体
 * 2. 混合搜索：向量相似度 + 图结构上下文
 * 3. 维护两个存储之间的引用一致性
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../services/infra/logger';
import { VectorStore, type VectorDocumentMetadata, type SearchResult as VectorSearchResult } from '../../memory/vectorStore';
import { getVectorStore } from '../../memory';
import { GraphStore, getGraphStore } from './graphStore';

import type {
  GraphEntity,
  GraphEntityCreateInput,
  GraphRelation,
  GraphRelationCreateInput,
  EntityFilter,
  RelationFilter,
  QueryResult,
  HybridSearchResult,
  NeighborhoodQueryOptions,
  HybridStoreConfig,
} from '../types';

const logger = createLogger('HybridStore');

// ============================================================================
// 配置常量
// ============================================================================

const DEFAULT_CONFIG: HybridStoreConfig = {
  graphStore: {
    dbPath: '', // 将在初始化时设置
  },
  vectorWeight: 0.6,
  graphWeight: 0.4,
  defaultNeighborhoodDepth: 2,
};

// ============================================================================
// 混合搜索选项
// ============================================================================

export interface HybridSearchOptions {
  /** 返回结果数量 */
  topK?: number;

  /** 最小相似度阈值（0-1） */
  threshold?: number;

  /** 实体类型过滤 */
  entityTypes?: GraphEntity['type'][];

  /** 项目路径过滤 */
  projectPath?: string;

  /** 是否包含关系上下文 */
  includeRelations?: boolean;

  /** 邻域查询深度（0 表示不查询邻域） */
  neighborhoodDepth?: number;

  /** 关系类型过滤（用于邻域查询） */
  relationTypes?: GraphRelation['type'][];

  /** 是否只返回有效实体 */
  onlyValid?: boolean;
}

// ============================================================================
// HybridStore 类
// ============================================================================

export class HybridStore {
  private vectorStore: VectorStore;
  private graphStore: GraphStore;
  private config: HybridStoreConfig;
  private initialized = false;

  constructor(config: Partial<HybridStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.vectorStore = getVectorStore();
    this.graphStore = getGraphStore();
  }

  // ==========================================================================
  // 初始化
  // ==========================================================================

  /**
   * 初始化混合存储
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // 初始化向量存储
      await this.vectorStore.initialize();

      // 初始化图存储
      await this.graphStore.initialize();

      this.initialized = true;
      logger.info('HybridStore initialized');
    } catch (error) {
      logger.error('Failed to initialize HybridStore:', error);
      throw error;
    }
  }

  /**
   * 关闭存储
   */
  async close(): Promise<void> {
    await this.graphStore.close();
    // VectorStore 不需要显式关闭
    this.initialized = false;
    logger.info('HybridStore closed');
  }

  // ==========================================================================
  // 实体操作
  // ==========================================================================

  /**
   * 创建实体（同时写入向量库和图库）
   */
  async addEntity(input: GraphEntityCreateInput): Promise<GraphEntity> {
    // 1. 先写入向量库获取 vectorId
    const vectorId = await this.vectorStore.add(input.content, {
      source: 'knowledge',
      entityType: input.type,
      entityName: input.name,
      projectPath: input.projectPath,
      sessionId: input.sessionId,
      filePath: input.location?.filePath,
    } as VectorDocumentMetadata);

    // 2. 写入图库，关联 vectorId
    const entity = await this.graphStore.createEntity({
      ...input,
      vectorId,
    });

    logger.debug(`Created entity: ${entity.id} (vector: ${vectorId})`);
    return entity;
  }

  /**
   * 批量创建实体
   */
  async addEntities(inputs: GraphEntityCreateInput[]): Promise<GraphEntity[]> {
    const entities: GraphEntity[] = [];

    for (const input of inputs) {
      const entity = await this.addEntity(input);
      entities.push(entity);
    }

    return entities;
  }

  /**
   * 更新实体
   */
  async updateEntity(
    id: string,
    updates: Partial<Omit<GraphEntity, 'id' | 'type' | 'createdAt'>>
  ): Promise<GraphEntity | null> {
    // 获取现有实体
    const existing = await this.graphStore.getEntity(id);
    if (!existing) return null;

    // 如果内容更新了，需要更新向量库
    if (updates.content && existing.vectorId) {
      // 删除旧的向量文档
      this.vectorStore.delete(existing.vectorId);

      // 创建新的向量文档
      const newVectorId = await this.vectorStore.add(updates.content, {
        source: 'knowledge',
        entityType: existing.type,
        entityName: updates.name || existing.name,
        projectPath: updates.projectPath || existing.projectPath,
        sessionId: updates.sessionId || existing.sessionId,
        filePath: updates.location?.filePath || existing.location?.filePath,
      } as VectorDocumentMetadata);

      updates.vectorId = newVectorId;
    }

    // 更新图库
    return this.graphStore.updateEntity(id, updates);
  }

  /**
   * 删除实体
   */
  async deleteEntity(id: string): Promise<boolean> {
    // 获取实体以获取 vectorId
    const entity = await this.graphStore.getEntity(id);
    if (!entity) return false;

    // 删除向量文档
    if (entity.vectorId) {
      this.vectorStore.delete(entity.vectorId);
    }

    // 删除图实体
    return this.graphStore.deleteEntity(id);
  }

  /**
   * 使实体失效（软删除）
   */
  async invalidateEntity(id: string): Promise<boolean> {
    return this.graphStore.invalidateEntity(id);
  }

  /**
   * 获取实体
   */
  async getEntity(id: string): Promise<GraphEntity | null> {
    return this.graphStore.getEntity(id);
  }

  /**
   * 查询实体
   */
  async queryEntities(filter?: EntityFilter): Promise<GraphEntity[]> {
    return this.graphStore.queryEntities({ filter });
  }

  // ==========================================================================
  // 关系操作
  // ==========================================================================

  /**
   * 创建关系
   */
  async addRelation(input: GraphRelationCreateInput): Promise<GraphRelation> {
    return this.graphStore.createRelation(input);
  }

  /**
   * 批量创建关系
   */
  async addRelations(inputs: GraphRelationCreateInput[]): Promise<GraphRelation[]> {
    const relations: GraphRelation[] = [];

    for (const input of inputs) {
      const relation = await this.addRelation(input);
      relations.push(relation);
    }

    return relations;
  }

  /**
   * 删除关系
   */
  async deleteRelation(id: string): Promise<boolean> {
    return this.graphStore.deleteRelation(id);
  }

  /**
   * 获取关系
   */
  async getRelation(id: string): Promise<GraphRelation | null> {
    return this.graphStore.getRelation(id);
  }

  /**
   * 查询关系
   */
  async queryRelations(filter?: RelationFilter): Promise<GraphRelation[]> {
    return this.graphStore.queryRelations({ filter });
  }

  // ==========================================================================
  // 混合搜索
  // ==========================================================================

  /**
   * 混合搜索：结合向量相似度和图结构上下文
   */
  async hybridSearch(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
    const {
      topK = 10,
      threshold = 0.3,
      entityTypes,
      projectPath,
      includeRelations = true,
      neighborhoodDepth = this.config.defaultNeighborhoodDepth,
      relationTypes,
      onlyValid = true,
    } = options;

    // 1. 向量搜索
    const vectorResults = await this.vectorStore.searchAsync(query, {
      topK: topK * 2, // 获取更多候选以便后续过滤
      threshold,
      filter: projectPath ? { projectPath } : undefined,
    });

    if (vectorResults.length === 0) {
      logger.debug('No vector search results');
      return [];
    }

    // 2. 获取对应的图实体
    const candidateResults: HybridSearchResult[] = [];

    for (const vr of vectorResults) {
      // 从向量文档的 metadata 中获取 entityId 或通过 vectorId 查找
      const entityId = (vr.document.metadata as Record<string, unknown>).entityId as string | undefined;

      if (entityId) {
        const entity = await this.graphStore.getEntity(entityId);
        if (entity) {
          // 类型过滤
          if (entityTypes?.length && !entityTypes.includes(entity.type)) {
            continue;
          }

          // 有效性过滤
          if (onlyValid && entity.validTo) {
            continue;
          }

          candidateResults.push({
            entity,
            score: vr.score,
            vectorScore: vr.score,
          });
        }
      }
    }

    // 3. 图上下文增强
    const effectiveDepth = neighborhoodDepth ?? this.config.defaultNeighborhoodDepth ?? 2;
    if (includeRelations && effectiveDepth > 0 && candidateResults.length > 0) {
      const entityIds = candidateResults.map(r => r.entity.id);

      const neighborhood = await this.graphStore.getNeighborhood({
        entityIds,
        depth: effectiveDepth,
        relationTypes,
        onlyValid,
      });

      // 计算图分数（基于关系数量和权重）
      for (const result of candidateResults) {
        const relatedRelations = neighborhood.relations.filter(
          r => r.fromId === result.entity.id || r.toId === result.entity.id
        );

        // 图分数：关系数量 * 平均权重
        const totalWeight = relatedRelations.reduce((sum, r) => sum + r.weight, 0);
        const graphScore = relatedRelations.length > 0
          ? (totalWeight / relatedRelations.length) * Math.min(relatedRelations.length / 5, 1)
          : 0;

        result.graphScore = graphScore;
        result.relations = relatedRelations;

        // 综合评分
        result.score =
          this.config.vectorWeight! * (result.vectorScore || 0) +
          this.config.graphWeight! * graphScore;
      }
    }

    // 4. 排序并返回 topK
    candidateResults.sort((a, b) => b.score - a.score);

    return candidateResults.slice(0, topK);
  }

  /**
   * 语义搜索（纯向量搜索，返回图实体）
   */
  async semanticSearch(query: string, options: Omit<HybridSearchOptions, 'includeRelations' | 'neighborhoodDepth'> = {}): Promise<HybridSearchResult[]> {
    return this.hybridSearch(query, {
      ...options,
      includeRelations: false,
      neighborhoodDepth: 0,
    });
  }

  /**
   * 结构化搜索（基于图遍历）
   */
  async structuralSearch(
    startEntityId: string,
    options: {
      depth?: number;
      relationTypes?: GraphRelation['type'][];
      direction?: 'outgoing' | 'incoming' | 'both';
    } = {}
  ): Promise<QueryResult> {
    const startTime = Date.now();
    const { depth = 2, relationTypes, direction = 'both' } = options;

    const result = await this.graphStore.getNeighborhood({
      entityIds: [startEntityId],
      depth,
      relationTypes,
      direction,
      onlyValid: true,
    });

    // 获取起始实体
    const startEntity = await this.graphStore.getEntity(startEntityId);
    const entities = startEntity ? [startEntity, ...result.entities] : result.entities;

    return {
      entities,
      relations: result.relations,
      queryType: 'structural',
      duration: Date.now() - startTime,
      totalCount: entities.length,
    };
  }

  // ==========================================================================
  // 上下文查询
  // ==========================================================================

  /**
   * 获取实体的完整上下文（实体 + 关系 + 相关实体）
   */
  async getEntityContext(
    entityId: string,
    options: {
      depth?: number;
      relationTypes?: GraphRelation['type'][];
      maxRelatedEntities?: number;
    } = {}
  ): Promise<{
    entity: GraphEntity | null;
    relations: GraphRelation[];
    relatedEntities: GraphEntity[];
  }> {
    const { depth = 1, relationTypes, maxRelatedEntities = 20 } = options;

    const entity = await this.graphStore.getEntity(entityId);
    if (!entity) {
      return { entity: null, relations: [], relatedEntities: [] };
    }

    const neighborhood = await this.graphStore.getNeighborhood({
      entityIds: [entityId],
      depth,
      relationTypes,
      maxNodes: maxRelatedEntities,
      onlyValid: true,
    });

    return {
      entity,
      relations: neighborhood.relations,
      relatedEntities: neighborhood.entities,
    };
  }

  /**
   * 按文件路径获取代码上下文
   */
  async getFileContext(filePath: string): Promise<QueryResult> {
    const startTime = Date.now();

    // 获取文件中的所有实体
    const entities = await this.graphStore.queryEntities({
      filter: {
        filePath,
        onlyValid: true,
      },
    });

    if (entities.length === 0) {
      return {
        entities: [],
        relations: [],
        queryType: 'structural',
        duration: Date.now() - startTime,
      };
    }

    // 获取这些实体之间的关系
    const entityIds = new Set(entities.map(e => e.id));
    const allRelations: GraphRelation[] = [];

    for (const entity of entities) {
      const relations = await this.graphStore.queryRelations({
        filter: { entityId: entity.id, onlyValid: true },
      });

      // 只保留两端都在当前文件中的关系
      for (const rel of relations) {
        if (entityIds.has(rel.fromId) && entityIds.has(rel.toId)) {
          allRelations.push(rel);
        }
      }
    }

    return {
      entities,
      relations: allRelations,
      queryType: 'structural',
      duration: Date.now() - startTime,
      totalCount: entities.length,
    };
  }

  /**
   * 获取会话上下文（对话中提取的实体和关系）
   */
  async getSessionContext(sessionId: string): Promise<QueryResult> {
    const startTime = Date.now();

    const entities = await this.graphStore.queryEntities({
      filter: {
        sessionId,
        onlyValid: true,
      },
    });

    const relations: GraphRelation[] = [];
    for (const entity of entities) {
      const entityRelations = await this.graphStore.queryRelations({
        filter: { entityId: entity.id, onlyValid: true },
      });
      relations.push(...entityRelations);
    }

    // 去重
    const uniqueRelations = Array.from(
      new Map(relations.map(r => [r.id, r])).values()
    );

    return {
      entities,
      relations: uniqueRelations,
      queryType: 'contextual',
      duration: Date.now() - startTime,
      totalCount: entities.length,
    };
  }

  // ==========================================================================
  // 统计
  // ==========================================================================

  /**
   * 获取混合存储统计
   */
  async getStats(): Promise<{
    graphStats: Awaited<ReturnType<GraphStore['getStats']>>;
    vectorDocumentCount: number;
  }> {
    const graphStats = await this.graphStore.getStats();
    const vectorStats = this.vectorStore.getStats();
    const vectorDocumentCount = vectorStats.documentCount;

    return {
      graphStats,
      vectorDocumentCount,
    };
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 记录实体访问（更新访问计数和时间）
   */
  async recordAccess(entityId: string): Promise<void> {
    const entity = await this.graphStore.getEntity(entityId);
    if (entity) {
      await this.graphStore.updateEntity(entityId, {
        accessCount: entity.accessCount + 1,
        lastAccessedAt: Date.now(),
      });
    }
  }

  /**
   * 批量记录访问
   */
  async recordAccessBatch(entityIds: string[]): Promise<void> {
    for (const id of entityIds) {
      await this.recordAccess(id);
    }
  }
}

// ============================================================================
// 单例导出
// ============================================================================

let hybridStoreInstance: HybridStore | null = null;

export function getHybridStore(): HybridStore {
  if (!hybridStoreInstance) {
    hybridStoreInstance = new HybridStore();
  }
  return hybridStoreInstance;
}

export async function initHybridStore(config?: Partial<HybridStoreConfig>): Promise<HybridStore> {
  if (hybridStoreInstance) {
    await hybridStoreInstance.close();
  }
  hybridStoreInstance = new HybridStore(config);
  await hybridStoreInstance.initialize();
  return hybridStoreInstance;
}
