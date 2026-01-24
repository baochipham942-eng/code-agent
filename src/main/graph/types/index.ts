/**
 * Graph Types - 统一导出
 */

// 实体类型
export * from './entities';

// 关系类型
export * from './relationships';

// ============================================================================
// 提取结果类型
// ============================================================================

import type { GraphEntity, GraphEntityCreateInput } from './entities';
import type { GraphRelation, GraphRelationCreateInput } from './relationships';

/**
 * 实体提取结果
 */
export interface ExtractedEntities {
  /** 提取的实体列表 */
  entities: GraphEntityCreateInput[];

  /** 提取的关系列表 */
  relations: GraphRelationCreateInput[];

  /** 提取来源 */
  source: 'code_analysis' | 'conversation';

  /** 提取时间 */
  extractedAt: number;

  /** 提取元数据 */
  metadata?: {
    /** 处理的文件路径 */
    filePath?: string;
    /** 处理的消息 ID */
    messageId?: string;
    /** 会话 ID */
    sessionId?: string;
    /** 使用的提取方法 */
    method?: 'tree-sitter' | 'llm' | 'rules';
  };
}

// ============================================================================
// 查询结果类型
// ============================================================================

/**
 * 查询结果
 */
export interface QueryResult {
  /** 匹配的实体 */
  entities: GraphEntity[];

  /** 相关的关系 */
  relations: GraphRelation[];

  /** 查询类型 */
  queryType: 'semantic' | 'structural' | 'hybrid' | 'temporal' | 'contextual';

  /** 查询耗时（ms） */
  duration: number;

  /** 结果总数（分页时使用） */
  totalCount?: number;

  /** 查询元数据 */
  metadata?: {
    /** 向量搜索分数 */
    vectorScores?: Map<string, number>;
    /** 图遍历深度 */
    graphDepth?: number;
  };
}

/**
 * 混合搜索结果
 */
export interface HybridSearchResult {
  /** 实体 */
  entity: GraphEntity;

  /** 综合得分（0-1） */
  score: number;

  /** 向量相似度得分 */
  vectorScore?: number;

  /** 图结构得分（基于关系数量和权重） */
  graphScore?: number;

  /** 相关的关系 */
  relations?: GraphRelation[];
}

// ============================================================================
// 图统计类型
// ============================================================================

import type { EntityStats } from './entities';
import type { RelationStats } from './relationships';

/**
 * 图整体统计
 */
export interface GraphStats {
  /** 实体统计 */
  entities: EntityStats;

  /** 关系统计 */
  relations: RelationStats;

  /** 图密度 */
  density: number;

  /** 平均出度 */
  averageOutDegree: number;

  /** 平均入度 */
  averageInDegree: number;

  /** 连通分量数 */
  connectedComponents?: number;

  /** 数据库大小（字节） */
  dbSizeBytes?: number;

  /** 最后更新时间 */
  lastUpdatedAt: number;
}

// ============================================================================
// 配置类型
// ============================================================================

/**
 * 图存储配置
 */
export interface GraphStoreConfig {
  /** 数据库目录 */
  dbPath: string;

  /** 是否启用写入缓冲 */
  enableWriteBuffer?: boolean;

  /** 写入缓冲大小 */
  writeBufferSize?: number;

  /** 是否启用读取缓存 */
  enableReadCache?: boolean;

  /** 读取缓存大小 */
  readCacheSize?: number;
}

/**
 * 混合存储配置
 */
export interface HybridStoreConfig {
  /** 图存储配置 */
  graphStore: GraphStoreConfig;

  /** 向量搜索权重（0-1） */
  vectorWeight?: number;

  /** 图搜索权重（0-1） */
  graphWeight?: number;

  /** 默认邻域查询深度 */
  defaultNeighborhoodDepth?: number;
}

// ============================================================================
// 事件类型
// ============================================================================

/**
 * 图事件类型
 */
export type GraphEventType =
  | 'entity:created'
  | 'entity:updated'
  | 'entity:deleted'
  | 'entity:invalidated'
  | 'relation:created'
  | 'relation:updated'
  | 'relation:deleted'
  | 'graph:compacted'
  | 'graph:rebuilt';

/**
 * 图事件
 */
export interface GraphEvent {
  /** 事件类型 */
  type: GraphEventType;

  /** 时间戳 */
  timestamp: number;

  /** 相关实体 ID */
  entityId?: string;

  /** 相关关系 ID */
  relationId?: string;

  /** 事件数据 */
  data?: unknown;
}

/**
 * 图事件监听器
 */
export type GraphEventListener = (event: GraphEvent) => void | Promise<void>;
