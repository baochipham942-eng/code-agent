// ============================================================================
// Result Aggregator - 搜索结果聚合器
// 负责去重、排序和来源标注
// ============================================================================

import type { SourceResult, DataSourceType } from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ResultAggregator');

// ----------------------------------------------------------------------------
// 类型定义
// ----------------------------------------------------------------------------

/**
 * 聚合配置
 */
export interface AggregatorConfig {
  /** 内容相似度阈值（0-1），超过此值视为重复 */
  similarityThreshold?: number;
  /** 最大结果数量 */
  maxResults?: number;
  /** 权威域名列表（这些来源会获得更高评分） */
  authoritativeDomains?: string[];
  /** 新鲜度权重（0-1） */
  freshnessWeight?: number;
  /** 相关度权重（0-1） */
  relevanceWeight?: number;
  /** 权威性权重（0-1） */
  authorityWeight?: number;
}

/**
 * 聚合后的结果
 */
export interface AggregatedResult extends SourceResult {
  /** 聚合评分 */
  aggregatedScore: number;
  /** 是否被标记为重复（已合并） */
  isDuplicate: boolean;
  /** 关联的重复项 URL */
  mergedFrom?: string[];
  /** 评分细节 */
  scoreBreakdown: {
    relevance: number;
    authority: number;
    freshness: number;
    sourceBonus: number;
  };
}

/**
 * 聚合统计
 */
export interface AggregationStats {
  /** 输入结果数 */
  inputCount: number;
  /** 输出结果数（去重后） */
  outputCount: number;
  /** 去重数量 */
  duplicatesRemoved: number;
  /** 来源分布 */
  sourceDistribution: Record<DataSourceType, number>;
  /** 处理耗时（毫秒） */
  processingTimeMs: number;
}

// ----------------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------------

/**
 * 从 URL 提取域名
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * 规范化 URL（去除查询参数等）
 */
function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // 移除常见的追踪参数
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source'];
    trackingParams.forEach(param => urlObj.searchParams.delete(param));
    // 移除尾部斜杠
    let normalized = urlObj.toString();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return url;
  }
}

/**
 * 计算两个字符串的相似度（Jaccard 相似度）
 */
function calculateSimilarity(text1: string, text2: string): number {
  if (!text1 || !text2) return 0;

  // 分词
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return 0;

  // 计算交集和并集
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * 计算新鲜度评分（基于抓取时间）
 */
function calculateFreshnessScore(fetchedAt: number, now: number = Date.now()): number {
  const ageMs = now - fetchedAt;
  const ageHours = ageMs / (1000 * 60 * 60);

  // 24 小时内：1.0
  // 1 周内：0.8
  // 1 月内：0.5
  // 更旧：0.2
  if (ageHours < 24) return 1.0;
  if (ageHours < 24 * 7) return 0.8;
  if (ageHours < 24 * 30) return 0.5;
  return 0.2;
}

/**
 * 数据源评分加成
 */
const SOURCE_BONUS: Record<DataSourceType, number> = {
  firecrawl_search: 1.2,
  firecrawl_scrape: 1.1,
  firecrawl_extract: 1.15,
  exa_search: 1.15,
  exa_code: 1.1,
  documentation: 1.3,  // 官方文档最高
  academic_search: 1.25,
  mcp_deepwiki: 1.1,
  mcp_github: 1.05,
  web_search: 1.0,
  news_search: 1.0,
  code_search: 1.05,
  local_codebase: 1.0,
  memory_store: 0.9,
};

/**
 * 默认权威域名
 */
const DEFAULT_AUTHORITATIVE_DOMAINS = [
  // 技术文档
  'developer.mozilla.org',
  'docs.microsoft.com',
  'docs.github.com',
  'cloud.google.com',
  'aws.amazon.com',
  'reactjs.org',
  'vuejs.org',
  'angular.io',
  'nodejs.org',
  'python.org',
  'rust-lang.org',
  'go.dev',
  // 学术
  'arxiv.org',
  'scholar.google.com',
  'researchgate.net',
  'ieee.org',
  'acm.org',
  // 技术社区
  'stackoverflow.com',
  'github.com',
  'medium.com',
  // 新闻
  'techcrunch.com',
  'theverge.com',
  'wired.com',
];

// ----------------------------------------------------------------------------
// Result Aggregator
// ----------------------------------------------------------------------------

/**
 * 搜索结果聚合器
 *
 * 功能：
 * 1. 去重：基于 URL 和内容相似度
 * 2. 排序：综合相关度、权威性、新鲜度
 * 3. 来源标注：标明结果来自哪个搜索源
 */
export class ResultAggregator {
  private similarityThreshold: number;
  private maxResults: number;
  private authoritativeDomains: Set<string>;
  private freshnessWeight: number;
  private relevanceWeight: number;
  private authorityWeight: number;

  constructor(config: AggregatorConfig = {}) {
    this.similarityThreshold = config.similarityThreshold ?? 0.7;
    this.maxResults = config.maxResults ?? 50;
    this.authoritativeDomains = new Set([
      ...DEFAULT_AUTHORITATIVE_DOMAINS,
      ...(config.authoritativeDomains ?? []),
    ]);
    this.freshnessWeight = config.freshnessWeight ?? 0.2;
    this.relevanceWeight = config.relevanceWeight ?? 0.5;
    this.authorityWeight = config.authorityWeight ?? 0.3;
  }

  /**
   * 聚合搜索结果
   *
   * @param results - 原始结果列表
   * @returns 聚合后的结果和统计信息
   */
  aggregate(results: SourceResult[]): {
    results: AggregatedResult[];
    stats: AggregationStats;
  } {
    const startTime = Date.now();

    if (results.length === 0) {
      return {
        results: [],
        stats: {
          inputCount: 0,
          outputCount: 0,
          duplicatesRemoved: 0,
          sourceDistribution: {} as Record<DataSourceType, number>,
          processingTimeMs: 0,
        },
      };
    }

    logger.debug('Starting aggregation', { inputCount: results.length });

    // 1. 评分并标注来源
    const scoredResults = results.map(result => this.scoreResult(result));

    // 2. 去重
    const deduplicated = this.deduplicate(scoredResults);

    // 3. 排序
    const sorted = deduplicated
      .filter(r => !r.isDuplicate)
      .sort((a, b) => b.aggregatedScore - a.aggregatedScore);

    // 4. 限制数量
    const final = sorted.slice(0, this.maxResults);

    // 统计来源分布
    const sourceDistribution = this.calculateSourceDistribution(final);

    const stats: AggregationStats = {
      inputCount: results.length,
      outputCount: final.length,
      duplicatesRemoved: results.length - deduplicated.filter(r => !r.isDuplicate).length,
      sourceDistribution,
      processingTimeMs: Date.now() - startTime,
    };

    logger.info('Aggregation complete', stats);

    return { results: final, stats };
  }

  /**
   * 为单个结果评分
   */
  private scoreResult(result: SourceResult): AggregatedResult {
    const domain = extractDomain(result.url);

    // 相关度评分（使用原始 relevanceScore 或默认 0.5）
    const relevance = result.relevanceScore ?? 0.5;

    // 权威性评分
    const authority = this.authoritativeDomains.has(domain) ? 1.0 : 0.5;

    // 新鲜度评分
    const freshness = calculateFreshnessScore(result.fetchedAt);

    // 来源加成
    const sourceBonus = SOURCE_BONUS[result.sourceType] ?? 1.0;

    // 综合评分
    const baseScore =
      relevance * this.relevanceWeight +
      authority * this.authorityWeight +
      freshness * this.freshnessWeight;

    const aggregatedScore = baseScore * sourceBonus;

    return {
      ...result,
      aggregatedScore,
      isDuplicate: false,
      scoreBreakdown: {
        relevance,
        authority,
        freshness,
        sourceBonus,
      },
    };
  }

  /**
   * 去重处理
   */
  private deduplicate(results: AggregatedResult[]): AggregatedResult[] {
    const urlMap = new Map<string, AggregatedResult>();
    const processedResults: AggregatedResult[] = [];

    for (const result of results) {
      const normalizedUrl = normalizeUrl(result.url);

      // URL 完全相同 -> 合并，保留评分更高的
      if (urlMap.has(normalizedUrl)) {
        const existing = urlMap.get(normalizedUrl)!;
        if (result.aggregatedScore > existing.aggregatedScore) {
          // 替换
          existing.isDuplicate = true;
          if (!result.mergedFrom) result.mergedFrom = [];
          result.mergedFrom.push(existing.url);
          urlMap.set(normalizedUrl, result);
        } else {
          // 标记当前为重复
          result.isDuplicate = true;
          if (!existing.mergedFrom) existing.mergedFrom = [];
          existing.mergedFrom.push(result.url);
        }
        continue;
      }

      // 内容相似度检查
      let foundSimilar = false;
      for (const [existingUrl, existing] of urlMap) {
        const similarity = calculateSimilarity(result.content, existing.content);
        if (similarity >= this.similarityThreshold) {
          foundSimilar = true;
          // 内容相似 -> 合并，保留评分更高的
          if (result.aggregatedScore > existing.aggregatedScore) {
            existing.isDuplicate = true;
            if (!result.mergedFrom) result.mergedFrom = [];
            result.mergedFrom.push(existing.url);
            urlMap.delete(existingUrl);
            urlMap.set(normalizedUrl, result);
          } else {
            result.isDuplicate = true;
            if (!existing.mergedFrom) existing.mergedFrom = [];
            existing.mergedFrom.push(result.url);
          }
          break;
        }
      }

      if (!foundSimilar) {
        urlMap.set(normalizedUrl, result);
      }
    }

    // 收集所有结果（包括标记为重复的）
    for (const result of results) {
      processedResults.push(result);
    }

    return processedResults;
  }

  /**
   * 计算来源分布
   */
  private calculateSourceDistribution(
    results: AggregatedResult[]
  ): Record<DataSourceType, number> {
    const distribution: Partial<Record<DataSourceType, number>> = {};

    for (const result of results) {
      distribution[result.sourceType] = (distribution[result.sourceType] ?? 0) + 1;
    }

    return distribution as Record<DataSourceType, number>;
  }

  /**
   * 添加权威域名
   */
  addAuthoritativeDomain(domain: string): void {
    this.authoritativeDomains.add(domain);
  }

  /**
   * 移除权威域名
   */
  removeAuthoritativeDomain(domain: string): void {
    this.authoritativeDomains.delete(domain);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AggregatorConfig>): void {
    if (config.similarityThreshold !== undefined) {
      this.similarityThreshold = config.similarityThreshold;
    }
    if (config.maxResults !== undefined) {
      this.maxResults = config.maxResults;
    }
    if (config.freshnessWeight !== undefined) {
      this.freshnessWeight = config.freshnessWeight;
    }
    if (config.relevanceWeight !== undefined) {
      this.relevanceWeight = config.relevanceWeight;
    }
    if (config.authorityWeight !== undefined) {
      this.authorityWeight = config.authorityWeight;
    }
    if (config.authoritativeDomains) {
      config.authoritativeDomains.forEach(d => this.authoritativeDomains.add(d));
    }
  }

  /**
   * 快速去重（仅基于 URL）
   * 用于性能敏感场景
   */
  quickDeduplicate(results: SourceResult[]): SourceResult[] {
    const seen = new Set<string>();
    return results.filter(result => {
      const normalized = normalizeUrl(result.url);
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
  }

  /**
   * 按来源分组
   */
  groupBySource(results: SourceResult[]): Map<DataSourceType, SourceResult[]> {
    const grouped = new Map<DataSourceType, SourceResult[]>();

    for (const result of results) {
      const group = grouped.get(result.sourceType) ?? [];
      group.push(result);
      grouped.set(result.sourceType, group);
    }

    return grouped;
  }

  /**
   * 格式化结果用于展示
   */
  formatForDisplay(result: AggregatedResult): string {
    const domain = extractDomain(result.url);
    const sourceLabel = this.getSourceLabel(result.sourceType);
    const scoreStr = result.aggregatedScore.toFixed(2);

    return `[${sourceLabel}] ${result.title} (${domain}) - Score: ${scoreStr}`;
  }

  /**
   * 获取数据源的显示标签
   */
  private getSourceLabel(sourceType: DataSourceType): string {
    const labels: Record<DataSourceType, string> = {
      firecrawl_search: '🔥 Firecrawl',
      firecrawl_scrape: '🔥 Firecrawl',
      firecrawl_extract: '🔥 Firecrawl',
      exa_search: '🔍 Exa',
      exa_code: '💻 Exa Code',
      web_search: '🌐 Web',
      news_search: '📰 News',
      academic_search: '📚 Academic',
      code_search: '💻 Code',
      documentation: '📖 Docs',
      mcp_deepwiki: '📚 DeepWiki',
      mcp_github: '🐙 GitHub',
      local_codebase: '📁 Local',
      memory_store: '🧠 Memory',
    };

    return labels[sourceType] ?? sourceType;
  }
}

// 导出默认实例
export const defaultAggregator = new ResultAggregator();
