// ============================================================================
// Capture Types - 浏览器采集相关类型定义
// ============================================================================

/**
 * 采集来源类型
 */
export type CaptureSource = 'browser_extension' | 'manual' | 'wechat' | 'local_file';

/**
 * 采集项
 */
export interface CaptureItem {
  id: string;
  url?: string;
  title: string;
  content: string;
  summary?: string;
  source: CaptureSource;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * 采集请求（从浏览器插件发送）
 */
export interface CaptureRequest {
  url?: string;
  title: string;
  content: string;
  html?: string;
  source?: CaptureSource;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * 采集搜索结果
 */
export interface CaptureSearchResult {
  item: CaptureItem;
  score: number;
  highlight?: string;
}

/**
 * 采集统计
 */
export interface CaptureStats {
  total: number;
  bySource: Record<CaptureSource, number>;
  recentlyAdded: number;
}
