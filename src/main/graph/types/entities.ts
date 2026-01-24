/**
 * Graph Entity Type Definitions
 *
 * 定义记忆图谱系统中的实体类型，包括：
 * - 代码实体：function, class, interface, module, variable
 * - 对话实体：user_preference, decision, requirement, error_pattern
 * - 知识实体：architecture_pattern, api_endpoint, dependency
 */

// ============================================================================
// 实体类型枚举
// ============================================================================

/**
 * 代码实体类型
 */
export const CodeEntityTypes = {
  FUNCTION: 'function',
  CLASS: 'class',
  INTERFACE: 'interface',
  MODULE: 'module',
  VARIABLE: 'variable',
  TYPE_ALIAS: 'type_alias',
  ENUM: 'enum',
} as const;

export type CodeEntityType = (typeof CodeEntityTypes)[keyof typeof CodeEntityTypes];

/**
 * 对话实体类型
 */
export const ConversationEntityTypes = {
  USER_PREFERENCE: 'user_preference',
  DECISION: 'decision',
  REQUIREMENT: 'requirement',
  ERROR_PATTERN: 'error_pattern',
  CONCEPT: 'concept',
  CONSTRAINT: 'constraint',
} as const;

export type ConversationEntityType =
  (typeof ConversationEntityTypes)[keyof typeof ConversationEntityTypes];

/**
 * 知识实体类型
 */
export const KnowledgeEntityTypes = {
  ARCHITECTURE_PATTERN: 'architecture_pattern',
  API_ENDPOINT: 'api_endpoint',
  DEPENDENCY: 'dependency',
  CONFIGURATION: 'configuration',
} as const;

export type KnowledgeEntityType = (typeof KnowledgeEntityTypes)[keyof typeof KnowledgeEntityTypes];

/**
 * 所有实体类型的联合
 */
export type EntityType = CodeEntityType | ConversationEntityType | KnowledgeEntityType;

export const AllEntityTypes = {
  ...CodeEntityTypes,
  ...ConversationEntityTypes,
  ...KnowledgeEntityTypes,
} as const;

// ============================================================================
// 实体来源
// ============================================================================

/**
 * 实体来源类型
 */
export const EntitySources = {
  /** 代码静态分析（Tree-sitter） */
  CODE_ANALYSIS: 'code_analysis',
  /** 对话提取（LLM 或规则） */
  CONVERSATION: 'conversation',
  /** 用户手动定义 */
  USER_DEFINED: 'user_defined',
  /** 系统推断 */
  INFERRED: 'inferred',
} as const;

export type EntitySource = (typeof EntitySources)[keyof typeof EntitySources];

// ============================================================================
// 核心实体接口
// ============================================================================

/**
 * 代码位置信息
 */
export interface CodeLocation {
  /** 文件路径（相对于项目根目录） */
  filePath: string;
  /** 起始行号（1-based） */
  startLine: number;
  /** 结束行号（1-based） */
  endLine: number;
  /** 起始列号（0-based） */
  startColumn?: number;
  /** 结束列号（0-based） */
  endColumn?: number;
}

/**
 * 函数签名信息
 */
export interface FunctionSignature {
  /** 参数列表 */
  parameters: Array<{
    name: string;
    type?: string;
    optional?: boolean;
    defaultValue?: string;
  }>;
  /** 返回类型 */
  returnType?: string;
  /** 是否异步 */
  isAsync?: boolean;
  /** 是否生成器 */
  isGenerator?: boolean;
}

/**
 * 类信息
 */
export interface ClassInfo {
  /** 父类 */
  extends?: string;
  /** 实现的接口 */
  implements?: string[];
  /** 是否抽象 */
  isAbstract?: boolean;
  /** 方法列表 */
  methods?: string[];
  /** 属性列表 */
  properties?: string[];
}

/**
 * 图实体 - 核心数据结构
 */
export interface GraphEntity {
  /** 唯一标识符 */
  id: string;

  /** 实体类型 */
  type: EntityType;

  /** 实体名称（函数名、类名、偏好标题等） */
  name: string;

  /** 详细内容（代码片段、偏好描述等） */
  content: string;

  /** 内容摘要（<200 字符，用于快速预览） */
  contentPreview: string;

  // -------------------------------------------------------------------------
  // 位置信息（仅代码实体）
  // -------------------------------------------------------------------------

  /** 代码位置 */
  location?: CodeLocation;

  // -------------------------------------------------------------------------
  // 类型特定信息
  // -------------------------------------------------------------------------

  /** 函数签名（type=function 时） */
  signature?: FunctionSignature;

  /** 类信息（type=class 时） */
  classInfo?: ClassInfo;

  // -------------------------------------------------------------------------
  // 来源追踪
  // -------------------------------------------------------------------------

  /** 实体来源 */
  source: EntitySource;

  /** 关联的会话 ID */
  sessionId?: string;

  /** 关联的项目路径 */
  projectPath?: string;

  /** 文件哈希（用于增量更新检测） */
  fileHash?: string;

  // -------------------------------------------------------------------------
  // 质量评分
  // -------------------------------------------------------------------------

  /** 置信度（0-1，用于质量控制和衰减） */
  confidence: number;

  /** 访问次数 */
  accessCount: number;

  /** 最后访问时间（Unix 时间戳 ms） */
  lastAccessedAt: number;

  // -------------------------------------------------------------------------
  // 时序信息
  // -------------------------------------------------------------------------

  /** 创建时间（Unix 时间戳 ms） */
  createdAt: number;

  /** 更新时间（Unix 时间戳 ms） */
  updatedAt: number;

  /** 有效期开始（Unix 时间戳 ms） */
  validFrom: number;

  /** 有效期结束（Unix 时间戳 ms，undefined 表示当前有效） */
  validTo?: number;

  // -------------------------------------------------------------------------
  // 关联信息
  // -------------------------------------------------------------------------

  /** VectorStore 中的文档 ID */
  vectorId?: string;

  /** 被此实体替代的旧版本 ID */
  supersedesId?: string;

  // -------------------------------------------------------------------------
  // 扩展元数据
  // -------------------------------------------------------------------------

  /** 自定义元数据 */
  metadata: Record<string, unknown>;
}

// ============================================================================
// 实体创建辅助类型
// ============================================================================

/**
 * 创建实体时的必填字段
 */
export type GraphEntityCreateInput = Pick<
  GraphEntity,
  'type' | 'name' | 'content' | 'source'
> &
  Partial<Omit<GraphEntity, 'id' | 'createdAt' | 'updatedAt' | 'validFrom'>>;

/**
 * 更新实体时的可选字段
 */
export type GraphEntityUpdateInput = Partial<
  Omit<GraphEntity, 'id' | 'type' | 'createdAt'>
>;

// ============================================================================
// 实体过滤和查询
// ============================================================================

/**
 * 实体过滤条件
 */
export interface EntityFilter {
  /** 按类型过滤 */
  types?: EntityType[];

  /** 按来源过滤 */
  sources?: EntitySource[];

  /** 按项目路径过滤 */
  projectPath?: string;

  /** 按会话 ID 过滤 */
  sessionId?: string;

  /** 按文件路径过滤（精确匹配） */
  filePath?: string;

  /** 按文件路径前缀过滤 */
  filePathPrefix?: string;

  /** 最小置信度 */
  minConfidence?: number;

  /** 是否只返回当前有效的实体 */
  onlyValid?: boolean;

  /** 时间范围 - 创建时间开始 */
  createdAfter?: number;

  /** 时间范围 - 创建时间结束 */
  createdBefore?: number;

  /** 搜索关键词（匹配 name 或 content） */
  keyword?: string;
}

/**
 * 实体排序选项
 */
export interface EntitySortOptions {
  /** 排序字段 */
  field: 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'confidence' | 'accessCount' | 'name';

  /** 排序方向 */
  direction: 'asc' | 'desc';
}

/**
 * 实体查询选项
 */
export interface EntityQueryOptions {
  /** 过滤条件 */
  filter?: EntityFilter;

  /** 排序选项 */
  sort?: EntitySortOptions;

  /** 分页 - 偏移量 */
  offset?: number;

  /** 分页 - 限制数量 */
  limit?: number;

  /** 是否包含关系信息 */
  includeRelations?: boolean;
}

// ============================================================================
// 实体统计
// ============================================================================

/**
 * 实体统计信息
 */
export interface EntityStats {
  /** 总实体数 */
  total: number;

  /** 按类型统计 */
  byType: Record<EntityType, number>;

  /** 按来源统计 */
  bySource: Record<EntitySource, number>;

  /** 有效实体数（validTo 为空） */
  validCount: number;

  /** 过期实体数（validTo 不为空） */
  expiredCount: number;

  /** 平均置信度 */
  averageConfidence: number;

  /** 最近更新时间 */
  lastUpdatedAt?: number;
}

// ============================================================================
// 工具函数类型
// ============================================================================

/**
 * 生成实体 ID 的函数类型
 */
export type EntityIdGenerator = () => string;

/**
 * 计算内容预览的函数类型
 */
export type ContentPreviewGenerator = (content: string, maxLength?: number) => string;

// ============================================================================
// 便捷常量数组（用于迭代和验证）
// ============================================================================

export const CODE_ENTITY_TYPES: readonly CodeEntityType[] = Object.values(CodeEntityTypes);
export const CONVERSATION_ENTITY_TYPES: readonly ConversationEntityType[] = Object.values(
  ConversationEntityTypes
).filter((v): v is ConversationEntityType => v !== 'concept') as ConversationEntityType[];
export const KNOWLEDGE_ENTITY_TYPES: readonly KnowledgeEntityType[] = [
  'architecture_pattern',
  'api_endpoint',
  'dependency',
  'concept',
] as const;
export const ALL_ENTITY_TYPES: readonly EntityType[] = [
  ...CODE_ENTITY_TYPES,
  ...CONVERSATION_ENTITY_TYPES,
  ...KNOWLEDGE_ENTITY_TYPES,
];

// ============================================================================
// 类型守卫函数
// ============================================================================

/**
 * 判断是否为代码实体类型
 */
export function isCodeEntityType(type: string): type is CodeEntityType {
  return (CODE_ENTITY_TYPES as readonly string[]).includes(type);
}

/**
 * 判断是否为对话实体类型
 */
export function isConversationEntityType(type: string): type is ConversationEntityType {
  return (CONVERSATION_ENTITY_TYPES as readonly string[]).includes(type);
}

/**
 * 判断是否为知识实体类型
 */
export function isKnowledgeEntityType(type: string): type is KnowledgeEntityType {
  return (KNOWLEDGE_ENTITY_TYPES as readonly string[]).includes(type);
}

/**
 * 判断是否为有效的实体类型
 */
export function isValidEntityType(type: string): type is EntityType {
  return (ALL_ENTITY_TYPES as readonly string[]).includes(type);
}

/**
 * 获取实体类型的分类
 */
export function getEntityTypeCategory(
  type: EntityType
): 'code' | 'conversation' | 'knowledge' | undefined {
  if (isCodeEntityType(type)) return 'code';
  if (isConversationEntityType(type)) return 'conversation';
  if (isKnowledgeEntityType(type)) return 'knowledge';
  return undefined;
}

/**
 * 判断实体类型的辅助函数（别名，保持向后兼容）
 */
export function isCodeEntity(type: EntityType): type is CodeEntityType {
  return isCodeEntityType(type);
}

export function isConversationEntity(type: EntityType): type is ConversationEntityType {
  return isConversationEntityType(type);
}

export function isKnowledgeEntity(type: EntityType): type is KnowledgeEntityType {
  return isKnowledgeEntityType(type);
}

/**
 * 获取实体类型的显示标签
 */
export function getEntityTypeLabel(type: EntityType): string {
  const labels: Record<EntityType, string> = {
    // 代码实体
    function: '函数',
    class: '类',
    interface: '接口',
    module: '模块',
    variable: '变量',
    type_alias: '类型别名',
    enum: '枚举',
    // 对话实体
    user_preference: '用户偏好',
    decision: '技术决策',
    requirement: '需求',
    error_pattern: '错误模式',
    concept: '概念',
    constraint: '约束',
    // 知识实体
    architecture_pattern: '架构模式',
    api_endpoint: 'API 端点',
    dependency: '依赖',
    configuration: '配置',
  };

  return labels[type] || type;
}
