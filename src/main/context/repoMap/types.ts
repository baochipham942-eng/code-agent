// ============================================================================
// Repo Map Types — 代码结构索引的核心类型定义
// ============================================================================

/** 符号类型 */
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method';

/** 单个符号条目 */
export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  /** 是否为 export 符号 */
  exported: boolean;
  /** 简化的签名（参数列表），用于显示 */
  signature?: string;
  line: number;
}

/** 单个文件的 Repo Map 条目 */
export interface RepoMapEntry {
  /** 相对于项目根目录的路径 */
  relativePath: string;
  /** 文件中提取的符号列表 */
  symbols: SymbolEntry[];
  /** 文件的 import 目标（相对路径或包名） */
  imports: string[];
  /** 最后修改时间（ms），用于增量更新 */
  mtime: number;
}

/** 依赖图中的节点 */
export interface DependencyNode {
  /** 相对文件路径 */
  path: string;
  /** 被其他文件 import 的次数（入度） */
  inDegree: number;
  /** import 了多少其他文件（出度） */
  outDegree: number;
  /** PageRank 分数 */
  rank: number;
}

/** Repo Map 构建配置 */
export interface RepoMapConfig {
  /** 项目根目录（绝对路径） */
  rootDir: string;
  /** Glob 模式 */
  patterns?: string[];
  /** 忽略目录 */
  ignore?: string[];
  /** 最大文件数 */
  maxFiles?: number;
  /** 输出 token 预算 */
  tokenBudget?: number;
}

/** Repo Map 构建结果 */
export interface RepoMapResult {
  /** 格式化后的 repo map 文本 */
  text: string;
  /** 包含的文件数 */
  fileCount: number;
  /** 包含的符号数 */
  symbolCount: number;
  /** 估算 token 数 */
  estimatedTokens: number;
}

/** 缓存状态 */
export interface RepoMapCacheState {
  /** 缓存的条目 */
  entries: Map<string, RepoMapEntry>;
  /** 最后一次完整构建时间 */
  lastFullBuild: number;
  /** 最后一次增量更新时间 */
  lastIncrementalUpdate: number;
  /** 项目根目录 */
  rootDir: string;
}
