// ============================================================================
// Cloud Tool Types - 云端工具类型定义
// Split from cloud.ts for maintainability
// ============================================================================

/**
 * 云端工具名称
 */
export type CloudToolName =
  | 'cloud_scrape'
  | 'cloud_search'
  | 'cloud_api'
  | 'cloud_memory_store'
  | 'cloud_memory_search';

/**
 * 云端工具请求基础接口
 */
export interface CloudToolRequest {
  tool: CloudToolName;
  userId?: string;
  sessionId?: string;
}

/**
 * cloud_scrape 请求
 */
export interface CloudScrapeRequest extends CloudToolRequest {
  tool: 'cloud_scrape';
  url: string;
  selector?: string;
  extractJsonLd?: boolean;
  waitForSelector?: string;
  timeout?: number;
}

/**
 * cloud_search 请求
 */
export interface CloudSearchRequest extends CloudToolRequest {
  tool: 'cloud_search';
  query: string;
  maxResults?: number;
  region?: string;
}

/**
 * cloud_api 请求
 */
export interface CloudApiRequest extends CloudToolRequest {
  tool: 'cloud_api';
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  cache?: boolean;
  cacheTTL?: number;
}

/**
 * cloud_memory_store 请求
 */
export interface CloudMemoryStoreRequest extends CloudToolRequest {
  tool: 'cloud_memory_store';
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
  projectId?: string;
}

/**
 * cloud_memory_search 请求
 */
export interface CloudMemorySearchRequest extends CloudToolRequest {
  tool: 'cloud_memory_search';
  query: string;
  limit?: number;
  threshold?: number;
  namespace?: string;
  projectId?: string;
  filters?: Record<string, unknown>;
}

/**
 * 云端工具响应
 */
export interface CloudToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  duration: number;
  cached?: boolean;
}

/**
 * 云端搜索结果项
 */
export interface CloudSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedDate?: string;
}

/**
 * 云端抓取结果
 */
export interface CloudScrapeResultData {
  url: string;
  title?: string;
  content: string;
  html?: string;
  extractedData?: Record<string, unknown>;
  jsonLd?: unknown[];
  metadata?: {
    statusCode: number;
    contentType: string;
    responseTime: number;
  };
}

/**
 * 云端 API 调用结果
 */
export interface CloudApiResultData {
  statusCode: number;
  data?: unknown;
  headers?: Record<string, string>;
  responseTime: number;
}

/**
 * 云端记忆搜索结果项
 */
export interface CloudMemoryResultItem {
  key: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
