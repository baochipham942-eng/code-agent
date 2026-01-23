// ============================================================================
// Data Source Router - 数据源路由器
// 根据查询类型动态选择合适的数据源
// ============================================================================

import type {
  QueryIntent,
  DataSourceType,
  IntentClassification,
} from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DataSourceRouter');

// ----------------------------------------------------------------------------
// 数据源映射配置
// ----------------------------------------------------------------------------

interface SourceMapping {
  /** 查询意图 */
  intent: QueryIntent;
  /** 主要数据源（优先使用） */
  primarySources: DataSourceType[];
  /** 辅助数据源（备选） */
  secondarySources: DataSourceType[];
  /** 选择理由 */
  rationale: string;
}

/**
 * 意图到数据源的映射
 */
const SOURCE_MAPPINGS: SourceMapping[] = [
  {
    intent: 'analysis',
    primarySources: ['web_search', 'academic_search', 'documentation'],
    secondarySources: ['mcp_deepwiki', 'news_search'],
    rationale: '深度分析需要权威来源和学术支持',
  },
  {
    intent: 'comparison',
    primarySources: ['web_search', 'documentation'],
    secondarySources: ['code_search', 'academic_search'],
    rationale: '对比研究需要多角度信息和官方文档',
  },
  {
    intent: 'current_events',
    primarySources: ['web_search', 'news_search'],
    secondarySources: [],
    rationale: '时事新闻需要最新的网络信息',
  },
  {
    intent: 'technical_deep_dive',
    primarySources: ['documentation', 'mcp_deepwiki', 'code_search'],
    secondarySources: ['web_search', 'academic_search'],
    rationale: '技术深挖优先使用官方文档和代码库',
  },
  {
    intent: 'explanation',
    primarySources: ['web_search', 'documentation'],
    secondarySources: ['mcp_deepwiki'],
    rationale: '解释说明需要清晰的文档和教程',
  },
  {
    intent: 'simple_lookup',
    primarySources: ['web_search'],
    secondarySources: [],
    rationale: '简单查询只需通用搜索',
  },
  {
    intent: 'factual_question',
    primarySources: ['web_search'],
    secondarySources: ['documentation'],
    rationale: '事实问题需要可靠的信息来源',
  },
  {
    intent: 'multi_faceted',
    primarySources: ['web_search', 'academic_search', 'documentation'],
    secondarySources: ['news_search', 'code_search', 'mcp_deepwiki'],
    rationale: '多面分析需要综合多种数据源',
  },
  {
    intent: 'code_task',
    primarySources: [],
    secondarySources: [],
    rationale: '代码任务不需要外部研究',
  },
  {
    intent: 'creative_task',
    primarySources: [],
    secondarySources: [],
    rationale: '创意任务不需要外部研究',
  },
];

/**
 * 数据源优先级（数值越小优先级越高）
 */
const SOURCE_PRIORITY: Record<DataSourceType, number> = {
  web_search: 1,
  documentation: 2,
  mcp_deepwiki: 3,
  code_search: 4,
  news_search: 5,
  academic_search: 6,
  mcp_github: 7,
  local_codebase: 8,
  memory_store: 9,
};

// ----------------------------------------------------------------------------
// Data Source Router
// ----------------------------------------------------------------------------

/**
 * 数据源可用性检查函数类型
 */
export type SourceAvailabilityChecker = (source: DataSourceType) => Promise<boolean>;

/**
 * 数据源路由器配置
 */
export interface DataSourceRouterConfig {
  /** 最大数据源数量 */
  maxSources?: number;
  /** 用户偏好的数据源 */
  preferredSources?: DataSourceType[];
  /** 可用性检查函数 */
  availabilityChecker?: SourceAvailabilityChecker;
}

/**
 * 数据源路由器
 *
 * 负责：
 * 1. 根据查询意图选择合适的数据源
 * 2. 检查数据源可用性
 * 3. 应用用户偏好
 */
export class DataSourceRouter {
  private maxSources: number;
  private preferredSources: DataSourceType[];
  private availabilityChecker?: SourceAvailabilityChecker;
  private availabilityCache: Map<DataSourceType, { available: boolean; checkedAt: number }>;
  private cacheExpireMs: number = 5 * 60 * 1000; // 5 分钟缓存

  constructor(config: DataSourceRouterConfig = {}) {
    this.maxSources = config.maxSources ?? 4;
    this.preferredSources = config.preferredSources ?? [];
    this.availabilityChecker = config.availabilityChecker;
    this.availabilityCache = new Map();
  }

  /**
   * 根据意图分类选择数据源
   *
   * @param classification - 意图分类结果
   * @returns 选中的数据源列表
   */
  async selectSources(classification: IntentClassification): Promise<DataSourceType[]> {
    const { intent, suggestedSources } = classification;

    // 获取映射配置
    const mapping = SOURCE_MAPPINGS.find(m => m.intent === intent);
    if (!mapping) {
      logger.warn('No mapping found for intent, using suggested sources:', intent);
      return suggestedSources.length > 0 ? suggestedSources : ['web_search'];
    }

    // 合并主要和辅助数据源
    const candidateSources = [...mapping.primarySources, ...mapping.secondarySources];

    // 过滤可用的数据源
    const availableSources = await this.filterAvailableSources(candidateSources);

    // 应用用户偏好
    const sortedSources = this.applyUserPreferences(availableSources);

    // 限制数量
    const selectedSources = sortedSources.slice(0, this.maxSources);

    logger.info('Selected data sources:', {
      intent,
      selected: selectedSources,
      rationale: mapping.rationale,
    });

    // 确保至少有一个数据源
    if (selectedSources.length === 0) {
      return ['web_search'];
    }

    return selectedSources;
  }

  /**
   * 快速选择数据源（不检查可用性）
   */
  selectSourcesSync(classification: IntentClassification): DataSourceType[] {
    const { intent, suggestedSources } = classification;

    const mapping = SOURCE_MAPPINGS.find(m => m.intent === intent);
    if (!mapping) {
      return suggestedSources.length > 0 ? suggestedSources : ['web_search'];
    }

    const candidateSources = [...mapping.primarySources, ...mapping.secondarySources];
    const sortedSources = this.applyUserPreferences(candidateSources);

    return sortedSources.slice(0, this.maxSources);
  }

  /**
   * 根据查询主题增强数据源选择
   *
   * @param baseSources - 基础数据源
   * @param topic - 查询主题
   * @returns 增强后的数据源
   */
  enhanceSourcesByTopic(baseSources: DataSourceType[], topic: string): DataSourceType[] {
    const lowerTopic = topic.toLowerCase();
    const enhancedSources = [...baseSources];

    // GitHub 相关 -> 添加 mcp_deepwiki
    if (/github|repo|repository|open\s*source/i.test(lowerTopic)) {
      if (!enhancedSources.includes('mcp_deepwiki')) {
        enhancedSources.push('mcp_deepwiki');
      }
    }

    // 编程/技术相关 -> 添加 code_search
    if (/code|programming|api|sdk|library|framework/i.test(lowerTopic)) {
      if (!enhancedSources.includes('code_search')) {
        enhancedSources.push('code_search');
      }
    }

    // 学术/研究相关 -> 添加 academic_search
    if (/paper|research|study|academic|scientific|论文|研究/i.test(lowerTopic)) {
      if (!enhancedSources.includes('academic_search')) {
        enhancedSources.push('academic_search');
      }
    }

    // 新闻/时事相关 -> 添加 news_search
    if (/news|latest|recent|今日|新闻|最新/i.test(lowerTopic)) {
      if (!enhancedSources.includes('news_search')) {
        enhancedSources.push('news_search');
      }
    }

    return enhancedSources.slice(0, this.maxSources + 2); // 允许略微超出限制
  }

  /**
   * 检查单个数据源是否可用
   */
  async checkSourceAvailability(source: DataSourceType): Promise<boolean> {
    // 检查缓存
    const cached = this.availabilityCache.get(source);
    if (cached && Date.now() - cached.checkedAt < this.cacheExpireMs) {
      return cached.available;
    }

    // 默认可用性判断
    let available = true;

    // web_search 默认可用
    if (source === 'web_search') {
      available = true;
    }
    // MCP 数据源需要检查连接
    else if (source.startsWith('mcp_')) {
      if (this.availabilityChecker) {
        available = await this.availabilityChecker(source);
      } else {
        // 没有检查器时，假设不可用
        available = false;
      }
    }
    // 其他数据源使用检查器或默认可用
    else if (this.availabilityChecker) {
      available = await this.availabilityChecker(source);
    }

    // 更新缓存
    this.availabilityCache.set(source, { available, checkedAt: Date.now() });

    return available;
  }

  /**
   * 过滤可用的数据源
   */
  private async filterAvailableSources(sources: DataSourceType[]): Promise<DataSourceType[]> {
    const availabilityChecks = sources.map(async source => ({
      source,
      available: await this.checkSourceAvailability(source),
    }));

    const results = await Promise.all(availabilityChecks);
    return results.filter(r => r.available).map(r => r.source);
  }

  /**
   * 应用用户偏好排序
   */
  private applyUserPreferences(sources: DataSourceType[]): DataSourceType[] {
    if (this.preferredSources.length === 0) {
      // 无偏好时按默认优先级排序
      return sources.sort((a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b]);
    }

    // 用户偏好的数据源优先
    return sources.sort((a, b) => {
      const aPreferred = this.preferredSources.includes(a);
      const bPreferred = this.preferredSources.includes(b);

      if (aPreferred && !bPreferred) return -1;
      if (!aPreferred && bPreferred) return 1;

      // 都在偏好中，按偏好顺序
      if (aPreferred && bPreferred) {
        return this.preferredSources.indexOf(a) - this.preferredSources.indexOf(b);
      }

      // 都不在偏好中，按默认优先级
      return SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b];
    });
  }

  /**
   * 更新用户偏好
   */
  setPreferredSources(sources: DataSourceType[]): void {
    this.preferredSources = sources;
  }

  /**
   * 清除可用性缓存
   */
  clearAvailabilityCache(): void {
    this.availabilityCache.clear();
  }

  /**
   * 获取数据源的执行策略
   */
  getExecutionStrategy(source: DataSourceType): {
    parallel: boolean;
    maxConcurrent: number;
    timeout: number;
  } {
    switch (source) {
      case 'web_search':
      case 'news_search':
        return { parallel: true, maxConcurrent: 3, timeout: 15000 };
      case 'academic_search':
        return { parallel: true, maxConcurrent: 2, timeout: 20000 };
      case 'documentation':
      case 'code_search':
        return { parallel: true, maxConcurrent: 3, timeout: 15000 };
      case 'mcp_deepwiki':
      case 'mcp_github':
        return { parallel: true, maxConcurrent: 2, timeout: 30000 };
      case 'local_codebase':
        return { parallel: false, maxConcurrent: 1, timeout: 10000 };
      case 'memory_store':
        return { parallel: false, maxConcurrent: 1, timeout: 5000 };
      default:
        return { parallel: true, maxConcurrent: 2, timeout: 15000 };
    }
  }
}
