/**
 * GraphStore - Kuzu 嵌入式图数据库封装
 *
 * 提供实体和关系的 CRUD 操作，以及图遍历查询能力。
 * 使用 Kuzu 作为底层存储，支持 Cypher 风格的查询语言。
 */

import * as kuzu from 'kuzu';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';

import type {
  GraphEntity,
  GraphEntityCreateInput,
  GraphEntityUpdateInput,
  EntityFilter,
  EntityQueryOptions,
  EntityStats,
  EntityType,
  EntitySource,
  GraphRelation,
  GraphRelationCreateInput,
  GraphRelationUpdateInput,
  RelationFilter,
  RelationQueryOptions,
  RelationStats,
  RelationType,
  NeighborhoodQueryOptions,
  PathQueryOptions,
  GraphPath,
  GraphStoreConfig,
  GraphStats,
  GraphEventType,
  GraphEvent,
  GraphEventListener,
} from '../types';

// ============================================================================
// 常量
// ============================================================================

function getDefaultDbPath(): string {
  try {
    // In electron environment
    return path.join(app.getPath('userData'), 'graph');
  } catch {
    // In test or non-electron environment
    return path.join(process.cwd(), '.graph-store');
  }
}

const DEFAULT_CONFIG: GraphStoreConfig = {
  dbPath: getDefaultDbPath(),
  enableWriteBuffer: true,
  writeBufferSize: 100,
  enableReadCache: true,
  readCacheSize: 1000,
};

// ============================================================================
// 辅助类型
// ============================================================================

type KuzuRow = Record<string, kuzu.KuzuValue>;

// ============================================================================
// GraphStore 类
// ============================================================================

export class GraphStore {
  private db: kuzu.Database | null = null;
  private conn: kuzu.Connection | null = null;
  private config: GraphStoreConfig;
  private initialized = false;
  private eventListeners: Map<GraphEventType, Set<GraphEventListener>> = new Map();

  // 读取缓存（简单 LRU）
  private entityCache: Map<string, { entity: GraphEntity; timestamp: number }> = new Map();

  constructor(config: Partial<GraphStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // 初始化与生命周期
  // ==========================================================================

  /**
   * 初始化图数据库
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 确保父目录存在（Kuzu 会自己创建数据库目录）
    const parentDir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    try {
      // 创建数据库实例
      this.db = new kuzu.Database(this.config.dbPath);
      await this.db.init();

      this.conn = new kuzu.Connection(this.db);
      await this.conn.init();

      // 初始化 schema
      await this.initializeSchema();

      this.initialized = true;
      console.log('[GraphStore] Initialized at:', this.config.dbPath);
    } catch (error) {
      console.error('[GraphStore] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * 初始化数据库 schema
   */
  private async initializeSchema(): Promise<void> {
    if (!this.conn) throw new Error('Database not connected');

    // 创建实体节点表
    await this.executeQuery(`
      CREATE NODE TABLE IF NOT EXISTS Entity (
        id STRING PRIMARY KEY,
        type STRING,
        name STRING,
        content STRING,
        contentPreview STRING,
        filePath STRING,
        startLine INT64,
        endLine INT64,
        source STRING,
        sessionId STRING,
        projectPath STRING,
        fileHash STRING,
        confidence DOUBLE,
        accessCount INT64,
        lastAccessedAt INT64,
        createdAt INT64,
        updatedAt INT64,
        validFrom INT64,
        validTo INT64,
        vectorId STRING,
        supersedesId STRING,
        metadata STRING
      )
    `);

    // 创建关系表 - 通用关系
    await this.executeQuery(`
      CREATE REL TABLE IF NOT EXISTS Relates (
        FROM Entity TO Entity,
        id STRING,
        type STRING,
        weight DOUBLE,
        confidence DOUBLE,
        createdAt INT64,
        validFrom INT64,
        validTo INT64,
        source STRING,
        sessionId STRING,
        metadata STRING
      )
    `);

    console.log('[GraphStore] Schema initialized');
  }

  /**
   * 执行查询的辅助方法
   */
  private async executeQuery(query: string): Promise<kuzu.QueryResult> {
    if (!this.conn) throw new Error('Database not connected');

    const result = await this.conn.query(query);

    // query 返回的可能是 QueryResult 或 QueryResult[]
    if (Array.isArray(result)) {
      return result[0];
    }
    return result;
  }

  /**
   * 执行带参数的查询
   */
  private async executeWithParams(
    query: string,
    params: Record<string, kuzu.KuzuValue>
  ): Promise<kuzu.QueryResult> {
    if (!this.conn) throw new Error('Database not connected');

    const stmt = await this.conn.prepare(query);
    if (!stmt.isSuccess()) {
      throw new Error(`Failed to prepare statement: ${stmt.getErrorMessage()}`);
    }

    const result = await this.conn.execute(stmt, params);

    // execute 返回的可能是 QueryResult 或 QueryResult[]
    if (Array.isArray(result)) {
      return result[0];
    }
    return result;
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }

    this.initialized = false;
    this.entityCache.clear();
    console.log('[GraphStore] Closed');
  }

  // ==========================================================================
  // 实体操作
  // ==========================================================================

  /**
   * 创建实体
   */
  async createEntity(input: GraphEntityCreateInput): Promise<GraphEntity> {
    const now = Date.now();
    const entity: GraphEntity = {
      id: uuidv4(),
      contentPreview: this.generatePreview(input.content),
      confidence: 1.0,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      metadata: {},
      ...input,
    };

    const query = `
      CREATE (e:Entity {
        id: $id,
        type: $type,
        name: $name,
        content: $content,
        contentPreview: $contentPreview,
        filePath: $filePath,
        startLine: $startLine,
        endLine: $endLine,
        source: $source,
        sessionId: $sessionId,
        projectPath: $projectPath,
        fileHash: $fileHash,
        confidence: $confidence,
        accessCount: $accessCount,
        lastAccessedAt: $lastAccessedAt,
        createdAt: $createdAt,
        updatedAt: $updatedAt,
        validFrom: $validFrom,
        validTo: $validTo,
        vectorId: $vectorId,
        supersedesId: $supersedesId,
        metadata: $metadata
      })
    `;

    await this.executeWithParams(query, {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      content: entity.content,
      contentPreview: entity.contentPreview,
      filePath: entity.location?.filePath || null,
      startLine: entity.location?.startLine ? BigInt(entity.location.startLine) : null,
      endLine: entity.location?.endLine ? BigInt(entity.location.endLine) : null,
      source: entity.source,
      sessionId: entity.sessionId || null,
      projectPath: entity.projectPath || null,
      fileHash: entity.fileHash || null,
      confidence: entity.confidence,
      accessCount: BigInt(entity.accessCount),
      lastAccessedAt: BigInt(entity.lastAccessedAt),
      createdAt: BigInt(entity.createdAt),
      updatedAt: BigInt(entity.updatedAt),
      validFrom: BigInt(entity.validFrom),
      validTo: entity.validTo ? BigInt(entity.validTo) : null,
      vectorId: entity.vectorId || null,
      supersedesId: entity.supersedesId || null,
      metadata: JSON.stringify(entity.metadata),
    });

    // 更新缓存
    if (this.config.enableReadCache) {
      this.entityCache.set(entity.id, { entity, timestamp: now });
    }

    // 发送事件
    this.emitEvent({ type: 'entity:created', timestamp: now, entityId: entity.id, data: entity });

    return entity;
  }

  /**
   * 获取实体
   */
  async getEntity(id: string): Promise<GraphEntity | null> {
    // 检查缓存
    if (this.config.enableReadCache) {
      const cached = this.entityCache.get(id);
      if (cached) {
        return cached.entity;
      }
    }

    const result = await this.executeWithParams(
      'MATCH (e:Entity {id: $id}) RETURN e',
      { id }
    );

    const rows = await result.getAll();
    if (rows.length === 0) return null;

    const entity = this.rowToEntity(rows[0]);

    // 更新缓存
    if (this.config.enableReadCache && entity) {
      this.entityCache.set(id, { entity, timestamp: Date.now() });
    }

    return entity;
  }

  /**
   * 更新实体
   */
  async updateEntity(id: string, updates: GraphEntityUpdateInput): Promise<GraphEntity | null> {
    const existing = await this.getEntity(id);
    if (!existing) return null;

    const now = Date.now();
    const updatedEntity: GraphEntity = {
      ...existing,
      ...updates,
      updatedAt: now,
    };

    // 构建动态更新查询
    const setClauses: string[] = ['e.updatedAt = $updatedAt'];
    const params: Record<string, kuzu.KuzuValue> = {
      id,
      updatedAt: BigInt(now),
    };

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'metadata') {
        setClauses.push(`e.${key} = $${key}`);
        params[key] = JSON.stringify(value);
      } else if (key === 'location') {
        const loc = value as GraphEntity['location'];
        if (loc) {
          setClauses.push('e.filePath = $filePath');
          setClauses.push('e.startLine = $startLine');
          setClauses.push('e.endLine = $endLine');
          params.filePath = loc.filePath;
          params.startLine = BigInt(loc.startLine);
          params.endLine = BigInt(loc.endLine);
        }
      } else if (typeof value === 'number') {
        setClauses.push(`e.${key} = $${key}`);
        // 某些字段需要 BigInt
        if (['accessCount', 'lastAccessedAt', 'createdAt', 'updatedAt', 'validFrom', 'validTo'].includes(key)) {
          params[key] = BigInt(value);
        } else {
          params[key] = value;
        }
      } else {
        setClauses.push(`e.${key} = $${key}`);
        params[key] = value as kuzu.KuzuValue;
      }
    }

    const query = `
      MATCH (e:Entity {id: $id})
      SET ${setClauses.join(', ')}
    `;

    await this.executeWithParams(query, params);

    // 更新缓存
    if (this.config.enableReadCache) {
      this.entityCache.set(id, { entity: updatedEntity, timestamp: now });
    }

    // 发送事件
    this.emitEvent({ type: 'entity:updated', timestamp: now, entityId: id, data: updates });

    return updatedEntity;
  }

  /**
   * 删除实体
   */
  async deleteEntity(id: string): Promise<boolean> {
    // 先删除相关的关系
    await this.executeWithParams(
      'MATCH (e:Entity {id: $id})-[r]-() DELETE r',
      { id }
    );

    // 删除实体
    await this.executeWithParams(
      'MATCH (e:Entity {id: $id}) DELETE e',
      { id }
    );

    // 清除缓存
    this.entityCache.delete(id);

    // 发送事件
    this.emitEvent({ type: 'entity:deleted', timestamp: Date.now(), entityId: id });

    return true;
  }

  /**
   * 使实体失效（软删除）
   */
  async invalidateEntity(id: string): Promise<boolean> {
    const result = await this.updateEntity(id, { validTo: Date.now() });

    if (result) {
      this.emitEvent({ type: 'entity:invalidated', timestamp: Date.now(), entityId: id });
    }

    return result !== null;
  }

  /**
   * 使文件的所有实体失效
   */
  async invalidateEntitiesFromFile(filePath: string): Promise<number> {
    const now = Date.now();

    // 先获取受影响的实体数量
    const countResult = await this.executeWithParams(
      `MATCH (e:Entity)
       WHERE e.filePath = $filePath AND e.validTo IS NULL
       RETURN count(e) as count`,
      { filePath }
    );

    const countRows = await countResult.getAll();
    const count = Number(countRows[0]?.count || 0);

    if (count > 0) {
      // 更新实体
      await this.executeWithParams(
        `MATCH (e:Entity)
         WHERE e.filePath = $filePath AND e.validTo IS NULL
         SET e.validTo = $validTo`,
        { filePath, validTo: BigInt(now) }
      );

      // 清除相关缓存
      for (const [key, cached] of this.entityCache.entries()) {
        if (cached.entity.location?.filePath === filePath) {
          this.entityCache.delete(key);
        }
      }
    }

    return count;
  }

  /**
   * 查询实体
   */
  async queryEntities(options: EntityQueryOptions = {}): Promise<GraphEntity[]> {
    const { filter, sort, offset = 0, limit = 100 } = options;

    let whereClause = 'true';
    const params: Record<string, kuzu.KuzuValue> = {
      offset: BigInt(offset),
      limit: BigInt(limit),
    };

    if (filter) {
      const conditions: string[] = [];

      if (filter.types?.length) {
        conditions.push(`e.type IN $types`);
        params.types = filter.types;
      }

      if (filter.sources?.length) {
        conditions.push(`e.source IN $sources`);
        params.sources = filter.sources;
      }

      if (filter.projectPath) {
        conditions.push(`e.projectPath = $projectPath`);
        params.projectPath = filter.projectPath;
      }

      if (filter.sessionId) {
        conditions.push(`e.sessionId = $sessionId`);
        params.sessionId = filter.sessionId;
      }

      if (filter.filePath) {
        conditions.push(`e.filePath = $filePath`);
        params.filePath = filter.filePath;
      }

      if (filter.filePathPrefix) {
        conditions.push(`starts_with(e.filePath, $filePathPrefix)`);
        params.filePathPrefix = filter.filePathPrefix;
      }

      if (filter.minConfidence !== undefined) {
        conditions.push(`e.confidence >= $minConfidence`);
        params.minConfidence = filter.minConfidence;
      }

      if (filter.onlyValid) {
        conditions.push(`e.validTo IS NULL`);
      }

      if (filter.createdAfter) {
        conditions.push(`e.createdAt >= $createdAfter`);
        params.createdAfter = BigInt(filter.createdAfter);
      }

      if (filter.createdBefore) {
        conditions.push(`e.createdAt <= $createdBefore`);
        params.createdBefore = BigInt(filter.createdBefore);
      }

      if (filter.keyword) {
        conditions.push(`(contains(e.name, $keyword) OR contains(e.content, $keyword))`);
        params.keyword = filter.keyword;
      }

      if (conditions.length > 0) {
        whereClause = conditions.join(' AND ');
      }
    }

    let orderClause = 'e.createdAt DESC';
    if (sort) {
      orderClause = `e.${sort.field} ${sort.direction.toUpperCase()}`;
    }

    const query = `
      MATCH (e:Entity)
      WHERE ${whereClause}
      RETURN e
      ORDER BY ${orderClause}
      SKIP $offset
      LIMIT $limit
    `;

    const result = await this.executeWithParams(query, params);
    const rows = await result.getAll();

    return rows.map((row: KuzuRow) => this.rowToEntity(row)).filter((e): e is GraphEntity => e !== null);
  }

  /**
   * 获取实体统计
   */
  async getEntityStats(): Promise<EntityStats> {
    const totalResult = await this.executeQuery('MATCH (e:Entity) RETURN count(e) as total');
    const totalRows = await totalResult.getAll();
    const total = Number(totalRows[0]?.total || 0);

    const byTypeResult = await this.executeQuery(
      'MATCH (e:Entity) RETURN e.type as type, count(e) as count'
    );
    const byTypeRows = await byTypeResult.getAll();
    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.type as string] = Number(row.count);
    }

    const bySourceResult = await this.executeQuery(
      'MATCH (e:Entity) RETURN e.source as source, count(e) as count'
    );
    const bySourceRows = await bySourceResult.getAll();
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) {
      bySource[row.source as string] = Number(row.count);
    }

    const validResult = await this.executeQuery(
      'MATCH (e:Entity) WHERE e.validTo IS NULL RETURN count(e) as count'
    );
    const validRows = await validResult.getAll();
    const validCount = Number(validRows[0]?.count || 0);

    const avgResult = await this.executeQuery(
      'MATCH (e:Entity) RETURN avg(e.confidence) as avgConfidence, max(e.updatedAt) as lastUpdated'
    );
    const avgRows = await avgResult.getAll();

    return {
      total,
      byType: byType as Record<EntityType, number>,
      bySource: bySource as Record<EntitySource, number>,
      validCount,
      expiredCount: total - validCount,
      averageConfidence: Number(avgRows[0]?.avgConfidence || 0),
      lastUpdatedAt: avgRows[0]?.lastUpdated ? Number(avgRows[0].lastUpdated) : undefined,
    };
  }

  // ==========================================================================
  // 关系操作
  // ==========================================================================

  /**
   * 创建关系
   */
  async createRelation(input: GraphRelationCreateInput): Promise<GraphRelation> {
    const now = Date.now();
    const relation: GraphRelation = {
      id: uuidv4(),
      weight: 1.0,
      confidence: 1.0,
      source: 'inferred',
      createdAt: now,
      validFrom: now,
      ...input,
    };

    const query = `
      MATCH (from:Entity {id: $fromId}), (to:Entity {id: $toId})
      CREATE (from)-[r:Relates {
        id: $id,
        type: $type,
        weight: $weight,
        confidence: $confidence,
        createdAt: $createdAt,
        validFrom: $validFrom,
        validTo: $validTo,
        source: $source,
        sessionId: $sessionId,
        metadata: $metadata
      }]->(to)
    `;

    await this.executeWithParams(query, {
      fromId: relation.fromId,
      toId: relation.toId,
      id: relation.id,
      type: relation.type,
      weight: relation.weight,
      confidence: relation.confidence,
      createdAt: BigInt(relation.createdAt),
      validFrom: BigInt(relation.validFrom),
      validTo: relation.validTo ? BigInt(relation.validTo) : null,
      source: relation.source,
      sessionId: relation.sessionId || null,
      metadata: relation.metadata ? JSON.stringify(relation.metadata) : null,
    });

    // 发送事件
    this.emitEvent({
      type: 'relation:created',
      timestamp: now,
      relationId: relation.id,
      data: relation,
    });

    return relation;
  }

  /**
   * 获取关系
   */
  async getRelation(id: string): Promise<GraphRelation | null> {
    const result = await this.executeWithParams(
      `MATCH (from:Entity)-[r:Relates {id: $id}]->(to:Entity)
       RETURN r, from.id as fromId, to.id as toId`,
      { id }
    );

    const rows = await result.getAll();
    if (rows.length === 0) return null;

    return this.rowToRelation(rows[0]);
  }

  /**
   * 更新关系
   */
  async updateRelation(id: string, updates: GraphRelationUpdateInput): Promise<GraphRelation | null> {
    const existing = await this.getRelation(id);
    if (!existing) return null;

    const updatedRelation: GraphRelation = {
      ...existing,
      ...updates,
    };

    const setClauses: string[] = [];
    const params: Record<string, kuzu.KuzuValue> = { id };

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'metadata') {
        setClauses.push(`r.${key} = $${key}`);
        params[key] = JSON.stringify(value);
      } else if (typeof value === 'number') {
        setClauses.push(`r.${key} = $${key}`);
        if (['createdAt', 'validFrom', 'validTo'].includes(key)) {
          params[key] = BigInt(value);
        } else {
          params[key] = value;
        }
      } else {
        setClauses.push(`r.${key} = $${key}`);
        params[key] = value as kuzu.KuzuValue;
      }
    }

    if (setClauses.length > 0) {
      const query = `
        MATCH ()-[r:Relates {id: $id}]->()
        SET ${setClauses.join(', ')}
      `;

      await this.executeWithParams(query, params);
    }

    this.emitEvent({
      type: 'relation:updated',
      timestamp: Date.now(),
      relationId: id,
      data: updates,
    });

    return updatedRelation;
  }

  /**
   * 删除关系
   */
  async deleteRelation(id: string): Promise<boolean> {
    await this.executeWithParams(
      'MATCH ()-[r:Relates {id: $id}]->() DELETE r',
      { id }
    );

    this.emitEvent({
      type: 'relation:deleted',
      timestamp: Date.now(),
      relationId: id,
    });

    return true;
  }

  /**
   * 查询关系
   */
  async queryRelations(options: RelationQueryOptions = {}): Promise<GraphRelation[]> {
    const { filter, sort, offset = 0, limit = 100 } = options;

    let whereClause = 'true';
    const params: Record<string, kuzu.KuzuValue> = {
      offset: BigInt(offset),
      limit: BigInt(limit),
    };

    if (filter) {
      const conditions: string[] = [];

      if (filter.types?.length) {
        conditions.push(`r.type IN $types`);
        params.types = filter.types;
      }

      if (filter.fromId) {
        conditions.push(`from.id = $fromId`);
        params.fromId = filter.fromId;
      }

      if (filter.toId) {
        conditions.push(`to.id = $toId`);
        params.toId = filter.toId;
      }

      if (filter.entityId) {
        conditions.push(`(from.id = $entityId OR to.id = $entityId)`);
        params.entityId = filter.entityId;
      }

      if (filter.minWeight !== undefined) {
        conditions.push(`r.weight >= $minWeight`);
        params.minWeight = filter.minWeight;
      }

      if (filter.minConfidence !== undefined) {
        conditions.push(`r.confidence >= $minConfidence`);
        params.minConfidence = filter.minConfidence;
      }

      if (filter.onlyValid) {
        conditions.push(`r.validTo IS NULL`);
      }

      if (filter.sources?.length) {
        conditions.push(`r.source IN $sources`);
        params.sources = filter.sources;
      }

      if (filter.sessionId) {
        conditions.push(`r.sessionId = $sessionId`);
        params.sessionId = filter.sessionId;
      }

      if (conditions.length > 0) {
        whereClause = conditions.join(' AND ');
      }
    }

    let orderClause = 'r.createdAt DESC';
    if (sort) {
      orderClause = `r.${sort.field} ${sort.direction.toUpperCase()}`;
    }

    const query = `
      MATCH (from:Entity)-[r:Relates]->(to:Entity)
      WHERE ${whereClause}
      RETURN r, from.id as fromId, to.id as toId
      ORDER BY ${orderClause}
      SKIP $offset
      LIMIT $limit
    `;

    const result = await this.executeWithParams(query, params);
    const rows = await result.getAll();

    return rows.map((row: KuzuRow) => this.rowToRelation(row)).filter((r): r is GraphRelation => r !== null);
  }

  /**
   * 获取关系统计
   */
  async getRelationStats(): Promise<RelationStats> {
    const totalResult = await this.executeQuery('MATCH ()-[r:Relates]->() RETURN count(r) as total');
    const totalRows = await totalResult.getAll();
    const total = Number(totalRows[0]?.total || 0);

    const byTypeResult = await this.executeQuery(
      'MATCH ()-[r:Relates]->() RETURN r.type as type, count(r) as count'
    );
    const byTypeRows = await byTypeResult.getAll();
    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.type as string] = Number(row.count);
    }

    const bySourceResult = await this.executeQuery(
      'MATCH ()-[r:Relates]->() RETURN r.source as source, count(r) as count'
    );
    const bySourceRows = await bySourceResult.getAll();
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) {
      bySource[row.source as string] = Number(row.count);
    }

    const validResult = await this.executeQuery(
      'MATCH ()-[r:Relates]->() WHERE r.validTo IS NULL RETURN count(r) as count'
    );
    const validRows = await validResult.getAll();
    const validCount = Number(validRows[0]?.count || 0);

    const avgResult = await this.executeQuery(
      'MATCH ()-[r:Relates]->() RETURN avg(r.weight) as avgWeight, avg(r.confidence) as avgConfidence'
    );
    const avgRows = await avgResult.getAll();

    return {
      total,
      byType: byType as Record<RelationType, number>,
      bySource,
      validCount,
      expiredCount: total - validCount,
      averageWeight: Number(avgRows[0]?.avgWeight || 0),
      averageConfidence: Number(avgRows[0]?.avgConfidence || 0),
    };
  }

  // ==========================================================================
  // 图遍历
  // ==========================================================================

  /**
   * 获取邻域（指定深度内的相邻节点）
   */
  async getNeighborhood(options: NeighborhoodQueryOptions): Promise<{
    entities: GraphEntity[];
    relations: GraphRelation[];
  }> {
    const {
      entityIds,
      depth = 1,
      direction = 'both',
      relationTypes,
      minWeight,
      maxNodes = 100,
      onlyValid = true,
    } = options;

    // 构建方向模式
    let relationPattern: string;
    switch (direction) {
      case 'outgoing':
        relationPattern = `-[r:Relates*1..${depth}]->`;
        break;
      case 'incoming':
        relationPattern = `<-[r:Relates*1..${depth}]-`;
        break;
      default:
        relationPattern = `-[r:Relates*1..${depth}]-`;
    }

    // 构建过滤条件
    const conditions: string[] = ['start.id IN $entityIds'];
    const params: Record<string, kuzu.KuzuValue> = {
      entityIds,
      maxNodes: BigInt(maxNodes),
    };

    if (relationTypes?.length) {
      conditions.push('ALL(rel IN r WHERE rel.type IN $relationTypes)');
      params.relationTypes = relationTypes;
    }

    if (minWeight !== undefined) {
      conditions.push('ALL(rel IN r WHERE rel.weight >= $minWeight)');
      params.minWeight = minWeight;
    }

    if (onlyValid) {
      conditions.push('ALL(rel IN r WHERE rel.validTo IS NULL)');
      conditions.push('neighbor.validTo IS NULL');
    }

    const whereClause = conditions.join(' AND ');

    const query = `
      MATCH (start:Entity)${relationPattern}(neighbor:Entity)
      WHERE ${whereClause}
      RETURN DISTINCT neighbor, r
      LIMIT $maxNodes
    `;

    const result = await this.executeWithParams(query, params);
    const rows = await result.getAll();

    const entitiesMap = new Map<string, GraphEntity>();
    const relationsMap = new Map<string, GraphRelation>();

    for (const row of rows) {
      const neighborNode = row.neighbor as kuzu.NodeValue;
      if (neighborNode) {
        const entity = this.nodeValueToEntity(neighborNode);
        if (entity) {
          entitiesMap.set(entity.id, entity);
        }
      }

      // 处理关系路径
      const relPath = row.r;
      if (Array.isArray(relPath)) {
        for (const relData of relPath) {
          const relation = this.relValueToRelation(relData as kuzu.RelValue);
          if (relation) {
            relationsMap.set(relation.id, relation);
          }
        }
      }
    }

    return {
      entities: Array.from(entitiesMap.values()),
      relations: Array.from(relationsMap.values()),
    };
  }

  /**
   * 查找两个实体之间的路径
   */
  async findPaths(options: PathQueryOptions): Promise<GraphPath[]> {
    const { fromId, toId, maxLength = 5, relationTypes, shortestOnly = false } = options;

    const typeFilter = relationTypes?.length
      ? `AND ALL(rel IN rels WHERE rel.type IN $relationTypes)`
      : '';

    const params: Record<string, kuzu.KuzuValue> = { fromId, toId };
    if (relationTypes?.length) {
      params.relationTypes = relationTypes;
    }

    // Kuzu 的最短路径语法略有不同
    const query = shortestOnly
      ? `MATCH p = (from:Entity {id: $fromId})-[rels:Relates*1..${maxLength}]->(to:Entity {id: $toId})
         WHERE from <> to ${typeFilter}
         RETURN nodes(p) as nodes, relationships(p) as rels
         ORDER BY length(p)
         LIMIT 1`
      : `MATCH p = (from:Entity {id: $fromId})-[rels:Relates*1..${maxLength}]->(to:Entity {id: $toId})
         WHERE from <> to ${typeFilter}
         RETURN nodes(p) as nodes, relationships(p) as rels
         LIMIT 10`;

    const result = await this.executeWithParams(query, params);
    const rows = await result.getAll();

    const paths: GraphPath[] = [];

    for (const row of rows) {
      const nodes = row.nodes as kuzu.NodeValue[];
      const rels = row.rels as kuzu.RelValue[];

      const entityIds = nodes.map(n => n.id as string);
      const relations = rels
        .map(r => this.relValueToRelation(r))
        .filter((r): r is GraphRelation => r !== null);

      const weight = relations.reduce((acc, r) => acc * r.weight, 1);

      paths.push({
        entityIds,
        relations,
        length: relations.length,
        weight,
      });
    }

    return paths;
  }

  // ==========================================================================
  // 整体统计
  // ==========================================================================

  /**
   * 获取图整体统计
   */
  async getStats(): Promise<GraphStats> {
    const [entityStats, relationStats] = await Promise.all([
      this.getEntityStats(),
      this.getRelationStats(),
    ]);

    // 计算图密度
    const n = entityStats.total;
    const e = relationStats.total;
    const density = n > 1 ? (2 * e) / (n * (n - 1)) : 0;

    // 计算平均度数
    const averageDegree = n > 0 ? (2 * e) / n : 0;

    return {
      entities: entityStats,
      relations: relationStats,
      density,
      averageOutDegree: averageDegree / 2,
      averageInDegree: averageDegree / 2,
      lastUpdatedAt: entityStats.lastUpdatedAt || Date.now(),
    };
  }

  // ==========================================================================
  // 事件系统
  // ==========================================================================

  /**
   * 订阅事件
   */
  on(event: GraphEventType, listener: GraphEventListener): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  /**
   * 取消订阅
   */
  off(event: GraphEventType, listener: GraphEventListener): void {
    this.eventListeners.get(event)?.delete(listener);
  }

  /**
   * 发送事件
   */
  private emitEvent(event: GraphEvent): void {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[GraphStore] Event listener error:', error);
        }
      }
    }
  }

  // ==========================================================================
  // 内部工具方法
  // ==========================================================================

  /**
   * 生成内容预览
   */
  private generatePreview(content: string, maxLength = 200): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength - 3) + '...';
  }

  /**
   * 将数据库行转换为实体对象
   */
  private rowToEntity(row: KuzuRow): GraphEntity | null {
    const e = row.e as kuzu.NodeValue | undefined;
    if (!e) return null;

    return this.nodeValueToEntity(e);
  }

  /**
   * 将 NodeValue 转换为 GraphEntity
   */
  private nodeValueToEntity(e: kuzu.NodeValue): GraphEntity | null {
    if (!e || !e.id) return null;

    return {
      id: e.id as string,
      type: e.type as GraphEntity['type'],
      name: e.name as string,
      content: e.content as string,
      contentPreview: e.contentPreview as string,
      location: e.filePath
        ? {
            filePath: e.filePath as string,
            startLine: Number(e.startLine || 0),
            endLine: Number(e.endLine || 0),
          }
        : undefined,
      source: e.source as GraphEntity['source'],
      sessionId: e.sessionId as string | undefined,
      projectPath: e.projectPath as string | undefined,
      fileHash: e.fileHash as string | undefined,
      confidence: e.confidence as number,
      accessCount: Number(e.accessCount || 0),
      lastAccessedAt: Number(e.lastAccessedAt || 0),
      createdAt: Number(e.createdAt || 0),
      updatedAt: Number(e.updatedAt || 0),
      validFrom: Number(e.validFrom || 0),
      validTo: e.validTo ? Number(e.validTo) : undefined,
      vectorId: e.vectorId as string | undefined,
      supersedesId: e.supersedesId as string | undefined,
      metadata: e.metadata ? JSON.parse(e.metadata as string) : {},
    };
  }

  /**
   * 将数据库行转换为关系对象
   */
  private rowToRelation(row: KuzuRow): GraphRelation | null {
    const r = row.r as kuzu.RelValue | undefined;
    if (!r) return null;

    return {
      id: r.id as string,
      fromId: row.fromId as string,
      toId: row.toId as string,
      type: r.type as GraphRelation['type'],
      weight: r.weight as number,
      confidence: r.confidence as number,
      createdAt: Number(r.createdAt || 0),
      validFrom: Number(r.validFrom || 0),
      validTo: r.validTo ? Number(r.validTo) : undefined,
      source: r.source as GraphRelation['source'],
      sessionId: r.sessionId as string | undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    };
  }

  /**
   * 将 RelValue 转换为 GraphRelation
   */
  private relValueToRelation(r: kuzu.RelValue): GraphRelation | null {
    if (!r || !r.id) return null;

    return {
      id: r.id as string,
      fromId: r._src ? `${r._src.table}:${r._src.offset}` : '',
      toId: r._dst ? `${r._dst.table}:${r._dst.offset}` : '',
      type: r.type as GraphRelation['type'],
      weight: r.weight as number,
      confidence: r.confidence as number,
      createdAt: Number(r.createdAt || 0),
      validFrom: Number(r.validFrom || 0),
      validTo: r.validTo ? Number(r.validTo) : undefined,
      source: r.source as GraphRelation['source'],
      sessionId: r.sessionId as string | undefined,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : undefined,
    };
  }
}

// ============================================================================
// 单例导出
// ============================================================================

let graphStoreInstance: GraphStore | null = null;

export function getGraphStore(): GraphStore {
  if (!graphStoreInstance) {
    graphStoreInstance = new GraphStore();
  }
  return graphStoreInstance;
}

export async function initGraphStore(config?: Partial<GraphStoreConfig>): Promise<GraphStore> {
  if (graphStoreInstance) {
    await graphStoreInstance.close();
  }
  graphStoreInstance = new GraphStore(config);
  await graphStoreInstance.initialize();
  return graphStoreInstance;
}
