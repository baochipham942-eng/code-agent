// ============================================================================
// ToolSearch Types - 工具搜索和延迟加载
// ============================================================================

import type { ToolTag, ToolSource } from './tool';
import type { GenerationId } from './generation';

/**
 * 工具搜索结果项
 */
export interface ToolSearchItem {
  /** 工具名称 */
  name: string;

  /** 工具描述 */
  description: string;

  /** 匹配得分（0-1，越高越相关） */
  score: number;

  /** 来源类型 */
  source: ToolSource;

  /** MCP 服务器名称（仅 MCP 工具） */
  mcpServer?: string;

  /** 分类标签 */
  tags: ToolTag[];
}

/**
 * 工具搜索结果
 */
export interface ToolSearchResult {
  /** 匹配的工具列表 */
  tools: ToolSearchItem[];

  /** 是否有更多结果 */
  hasMore: boolean;

  /** 总匹配数量 */
  totalCount: number;

  /** 本次搜索加载的工具名称 */
  loadedTools: string[];
}

/**
 * 工具搜索选项
 */
export interface ToolSearchOptions {
  /** 最大返回结果数（默认 5） */
  maxResults?: number;

  /** 必须匹配的前缀（用 + 标记） */
  requiredPrefix?: string;

  /** 代际过滤 */
  generationId?: GenerationId;

  /** 是否包含 MCP 工具（默认 true） */
  includeMCP?: boolean;
}

/**
 * 延迟工具元数据
 * 用于在不加载完整工具定义的情况下进行搜索匹配
 */
export interface DeferredToolMeta {
  /** 工具名称 */
  name: string;

  /** 简短描述（用于搜索结果显示） */
  shortDescription: string;

  /** 分类标签 */
  tags: ToolTag[];

  /** 搜索别名 */
  aliases: string[];

  /** 来源类型 */
  source: ToolSource;

  /** MCP 服务器名称 */
  mcpServer?: string;

  /** 关联的代际 */
  generations: string[];
}

/**
 * ToolSearch 查询模式
 */
export type ToolSearchQueryMode =
  | { type: 'keyword'; keywords: string[] }
  | { type: 'select'; toolName: string }
  | { type: 'required'; requiredWord: string; keywords: string[] };
