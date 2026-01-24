/**
 * Graph Relationship Type Definitions
 *
 * 定义记忆图谱系统中的关系类型，包括：
 * - 代码关系：calls, imports, extends, implements, uses, defines, contains
 * - 语义关系：related_to, similar_to, solves, conflicts_with
 * - 时序关系：supersedes, derived_from
 */

// ============================================================================
// 关系类型枚举
// ============================================================================

/**
 * 代码关系类型
 */
export const CodeRelationTypes = {
  /** 函数调用关系 */
  CALLS: 'calls',
  /** 模块导入关系 */
  IMPORTS: 'imports',
  /** 类继承关系 */
  EXTENDS: 'extends',
  /** 接口实现关系 */
  IMPLEMENTS: 'implements',
  /** 使用关系（变量、类型等） */
  USES: 'uses',
  /** 定义关系 */
  DEFINES: 'defines',
  /** 包含关系（模块包含函数等） */
  CONTAINS: 'contains',
  /** 依赖关系 */
  DEPENDS_ON: 'depends_on',
  /** 方法覆写 */
  OVERRIDES: 'overrides',
  /** 导出关系 */
  EXPORTS: 'exports',
} as const;

export type CodeRelationType = (typeof CodeRelationTypes)[keyof typeof CodeRelationTypes];

/**
 * 语义关系类型
 */
export const SemanticRelationTypes = {
  /** 通用语义关联 */
  RELATED_TO: 'related_to',
  /** 功能相似 */
  SIMILAR_TO: 'similar_to',
  /** 替代方案 */
  ALTERNATIVE_TO: 'alternative_to',
  /** 解决问题 */
  SOLVES: 'solves',
  /** 因果关系 */
  CAUSES: 'causes',
  /** 前置条件 */
  REQUIRES: 'requires',
  /** 冲突关系 */
  CONFLICTS_WITH: 'conflicts_with',
  /** 提及关系 */
  MENTIONS: 'mentions',
} as const;

export type SemanticRelationType = (typeof SemanticRelationTypes)[keyof typeof SemanticRelationTypes];

/**
 * 时序关系类型
 */
export const TemporalRelationTypes = {
  /** 版本替代（新版本替代旧版本） */
  SUPERSEDES: 'supersedes',
  /** 衍生自 */
  DERIVED_FROM: 'derived_from',
  /** 同时发生 */
  CONCURRENT_WITH: 'concurrent_with',
  /** 之前 */
  BEFORE: 'before',
  /** 之后 */
  AFTER: 'after',
  /** 先于（时序上在前） */
  PRECEDES: 'precedes',
} as const;

export type TemporalRelationType =
  (typeof TemporalRelationTypes)[keyof typeof TemporalRelationTypes];

/**
 * 所有关系类型的联合
 */
export type RelationType = CodeRelationType | SemanticRelationType | TemporalRelationType;

export const AllRelationTypes = {
  ...CodeRelationTypes,
  ...SemanticRelationTypes,
  ...TemporalRelationTypes,
} as const;

// ============================================================================
// 核心关系接口
// ============================================================================

/**
 * 图关系 - 核心数据结构
 */
export interface GraphRelation {
  /** 唯一标识符 */
  id: string;

  /** 起点实体 ID */
  fromId: string;

  /** 终点实体 ID */
  toId: string;

  /** 关系类型 */
  type: RelationType;

  // -------------------------------------------------------------------------
  // 关系强度
  // -------------------------------------------------------------------------

  /** 关系权重（0-1，用于排序和过滤） */
  weight: number;

  /** 置信度（0-1，用于质量控制） */
  confidence: number;

  // -------------------------------------------------------------------------
  // 时序信息
  // -------------------------------------------------------------------------

  /** 创建时间（Unix 时间戳 ms） */
  createdAt: number;

  /** 有效期开始（Unix 时间戳 ms） */
  validFrom: number;

  /** 有效期结束（Unix 时间戳 ms，undefined 表示当前有效） */
  validTo?: number;

  // -------------------------------------------------------------------------
  // 来源信息
  // -------------------------------------------------------------------------

  /** 关系来源 */
  source: 'code_analysis' | 'conversation' | 'user_defined' | 'inferred';

  /** 关联的会话 ID */
  sessionId?: string;

  // -------------------------------------------------------------------------
  // 扩展元数据
  // -------------------------------------------------------------------------

  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 特定关系类型的元数据
// ============================================================================

/**
 * 调用关系的元数据
 */
export interface CallsRelationMetadata {
  /** 调用次数（在同一文件中） */
  callCount?: number;
  /** 调用位置（行号列表） */
  callLocations?: number[];
  /** 是否条件调用 */
  isConditional?: boolean;
  /** 是否在循环中调用 */
  isInLoop?: boolean;
}

/**
 * 导入关系的元数据
 */
export interface ImportsRelationMetadata {
  /** 导入的具体符号 */
  importedSymbols?: string[];
  /** 是否默认导入 */
  isDefaultImport?: boolean;
  /** 是否命名空间导入 */
  isNamespaceImport?: boolean;
  /** 导入别名 */
  alias?: string;
}

/**
 * 继承关系的元数据
 */
export interface ExtendsRelationMetadata {
  /** 是否直接继承 */
  isDirect?: boolean;
  /** 继承深度（直接=1，间接>1） */
  depth?: number;
}

/**
 * 时序关系的元数据
 */
export interface TemporalRelationMetadata {
  /** 变更原因 */
  changeReason?: string;
  /** 变更类型 */
  changeType?: 'update' | 'refactor' | 'fix' | 'deprecate';
}

// ============================================================================
// 关系创建和更新
// ============================================================================

/**
 * 创建关系时的输入
 */
export type GraphRelationCreateInput = Pick<
  GraphRelation,
  'fromId' | 'toId' | 'type'
> &
  Partial<Omit<GraphRelation, 'id' | 'createdAt' | 'validFrom'>>;

/**
 * 更新关系时的输入
 */
export type GraphRelationUpdateInput = Partial<
  Omit<GraphRelation, 'id' | 'fromId' | 'toId' | 'type' | 'createdAt'>
>;

// ============================================================================
// 关系过滤和查询
// ============================================================================

/**
 * 关系过滤条件
 */
export interface RelationFilter {
  /** 按类型过滤 */
  types?: RelationType[];

  /** 起点实体 ID */
  fromId?: string;

  /** 终点实体 ID */
  toId?: string;

  /** 起点或终点实体 ID（任意方向） */
  entityId?: string;

  /** 最小权重 */
  minWeight?: number;

  /** 最小置信度 */
  minConfidence?: number;

  /** 是否只返回当前有效的关系 */
  onlyValid?: boolean;

  /** 按来源过滤 */
  sources?: GraphRelation['source'][];

  /** 按会话 ID 过滤 */
  sessionId?: string;
}

/**
 * 关系排序选项
 */
export interface RelationSortOptions {
  /** 排序字段 */
  field: 'createdAt' | 'weight' | 'confidence';

  /** 排序方向 */
  direction: 'asc' | 'desc';
}

/**
 * 关系查询选项
 */
export interface RelationQueryOptions {
  /** 过滤条件 */
  filter?: RelationFilter;

  /** 排序选项 */
  sort?: RelationSortOptions;

  /** 分页 - 偏移量 */
  offset?: number;

  /** 分页 - 限制数量 */
  limit?: number;
}

// ============================================================================
// 图遍历相关
// ============================================================================

/**
 * 遍历方向
 */
export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

/**
 * 邻域查询选项
 */
export interface NeighborhoodQueryOptions {
  /** 起始实体 ID 列表 */
  entityIds: string[];

  /** 遍历深度（默认 1） */
  depth?: number;

  /** 遍历方向（默认 both） */
  direction?: TraversalDirection;

  /** 关系类型过滤 */
  relationTypes?: RelationType[];

  /** 最小关系权重 */
  minWeight?: number;

  /** 最大返回节点数 */
  maxNodes?: number;

  /** 是否只返回有效关系 */
  onlyValid?: boolean;
}

/**
 * 路径查询选项
 */
export interface PathQueryOptions {
  /** 起点实体 ID */
  fromId: string;

  /** 终点实体 ID */
  toId: string;

  /** 最大路径长度 */
  maxLength?: number;

  /** 关系类型过滤 */
  relationTypes?: RelationType[];

  /** 是否只返回最短路径 */
  shortestOnly?: boolean;
}

/**
 * 图路径
 */
export interface GraphPath {
  /** 路径上的实体 ID 列表 */
  entityIds: string[];

  /** 路径上的关系列表 */
  relations: GraphRelation[];

  /** 路径长度 */
  length: number;

  /** 路径权重（关系权重之积） */
  weight: number;
}

// ============================================================================
// 关系统计
// ============================================================================

/**
 * 关系统计信息
 */
export interface RelationStats {
  /** 总关系数 */
  total: number;

  /** 按类型统计 */
  byType: Record<RelationType, number>;

  /** 按来源统计 */
  bySource: Record<string, number>;

  /** 有效关系数 */
  validCount: number;

  /** 过期关系数 */
  expiredCount: number;

  /** 平均权重 */
  averageWeight: number;

  /** 平均置信度 */
  averageConfidence: number;
}

// ============================================================================
// 便捷常量数组（用于迭代和验证）
// ============================================================================

export const CODE_RELATION_TYPES: readonly CodeRelationType[] = [
  'calls',
  'imports',
  'extends',
  'implements',
  'uses',
  'defines',
  'contains',
];

export const SEMANTIC_RELATION_TYPES: readonly SemanticRelationType[] = [
  'related_to',
  'solves',
  'conflicts_with',
  'similar_to',
  'alternative_to',
  'causes',
  'requires',
  'mentions',
];

export const TEMPORAL_RELATION_TYPES: readonly TemporalRelationType[] = [
  'supersedes',
  'derived_from',
  'precedes',
];

export const ALL_RELATION_TYPES: readonly RelationType[] = [
  ...CODE_RELATION_TYPES,
  ...SEMANTIC_RELATION_TYPES,
  ...TEMPORAL_RELATION_TYPES,
];

// ============================================================================
// 类型守卫函数
// ============================================================================

/**
 * 判断是否为代码关系类型
 */
export function isCodeRelationType(type: string): type is CodeRelationType {
  return (CODE_RELATION_TYPES as readonly string[]).includes(type);
}

/**
 * 判断是否为语义关系类型
 */
export function isSemanticRelationType(type: string): type is SemanticRelationType {
  return (SEMANTIC_RELATION_TYPES as readonly string[]).includes(type);
}

/**
 * 判断是否为时序关系类型
 */
export function isTemporalRelationType(type: string): type is TemporalRelationType {
  return (TEMPORAL_RELATION_TYPES as readonly string[]).includes(type);
}

/**
 * 判断是否为有效的关系类型
 */
export function isValidRelationType(type: string): type is RelationType {
  return (ALL_RELATION_TYPES as readonly string[]).includes(type);
}

/**
 * 获取关系类型的分类
 */
export function getRelationTypeCategory(
  type: RelationType
): 'code' | 'semantic' | 'temporal' | undefined {
  if (isCodeRelationType(type)) return 'code';
  if (isSemanticRelationType(type)) return 'semantic';
  if (isTemporalRelationType(type)) return 'temporal';
  return undefined;
}

/**
 * 判断关系类型的辅助函数（别名，保持向后兼容）
 */
export function isCodeRelation(type: RelationType): type is CodeRelationType {
  return isCodeRelationType(type);
}

export function isSemanticRelation(type: RelationType): type is SemanticRelationType {
  return isSemanticRelationType(type);
}

export function isTemporalRelation(type: RelationType): type is TemporalRelationType {
  return isTemporalRelationType(type);
}

/**
 * 获取关系类型的显示标签
 */
export function getRelationTypeLabel(type: RelationType): string {
  const labels: Record<RelationType, string> = {
    // 代码关系
    calls: '调用',
    imports: '导入',
    extends: '继承',
    implements: '实现',
    uses: '使用',
    defines: '定义',
    contains: '包含',
    depends_on: '依赖',
    overrides: '覆写',
    exports: '导出',
    // 语义关系
    related_to: '相关',
    similar_to: '类似',
    alternative_to: '替代',
    solves: '解决',
    causes: '导致',
    requires: '需要',
    conflicts_with: '冲突',
    mentions: '提及',
    // 时序关系
    supersedes: '替代',
    derived_from: '衍生自',
    precedes: '前置',
    concurrent_with: '并发',
    before: '之前',
    after: '之后',
  };

  return labels[type] || type;
}

/**
 * 获取关系的反向类型（如果存在）
 */
export function getInverseRelationType(type: RelationType): RelationType | null {
  const inverseMap: Partial<Record<RelationType, RelationType>> = {
    calls: 'calls', // 调用关系本身不对称，但可以反向查询
    imports: 'exports',
    extends: 'extends',
    implements: 'implements',
    contains: 'contains',
    supersedes: 'derived_from',
    derived_from: 'supersedes',
    before: 'after',
    after: 'before',
  };

  return inverseMap[type] || null;
}

/**
 * 检查关系是否为对称关系
 */
export function isSymmetricRelation(type: RelationType): boolean {
  const symmetricTypes: RelationType[] = [
    'related_to',
    'similar_to',
    'conflicts_with',
    'concurrent_with',
  ];

  return symmetricTypes.includes(type);
}
