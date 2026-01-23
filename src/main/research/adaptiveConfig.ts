// ============================================================================
// Adaptive Config - 自适应研究配置
// 根据意图分类动态生成研究参数
// ============================================================================

import type {
  IntentClassification,
  ResearchDepth,
  DataSourceType,
  AdaptiveResearchConfig,
  ReportStyle,
  ResearchUserSettings,
} from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AdaptiveConfig');

// ----------------------------------------------------------------------------
// 预设配置档位
// ----------------------------------------------------------------------------

/**
 * 深度档位预设配置
 */
interface DepthPreset {
  /** 并行搜索数量 */
  parallelSearches: number;
  /** 每次搜索返回结果数 */
  resultsPerSearch: number;
  /** 每次搜索最大抓取页面数 */
  maxFetchesPerSearch: number;
  /** 最大迭代轮数 */
  maxIterations: number;
  /** 覆盖度阈值 */
  coverageThreshold: number;
  /** 新颖度阈值 */
  noveltyThreshold: number;
  /** 最大持续时间（毫秒） */
  maxDurationMs: number;
  /** 最大搜索调用次数 */
  maxSearchCalls: number;
  /** 最大页面抓取次数 */
  maxPageFetches: number;
}

/**
 * 三档深度预设
 */
const DEPTH_PRESETS: Record<ResearchDepth, DepthPreset> = {
  quick: {
    parallelSearches: 2,
    resultsPerSearch: 5,
    maxFetchesPerSearch: 2,
    maxIterations: 1,
    coverageThreshold: 0.6,
    noveltyThreshold: 0.1,
    maxDurationMs: 30 * 1000, // 30 秒
    maxSearchCalls: 5,
    maxPageFetches: 10,
  },
  standard: {
    parallelSearches: 4,
    resultsPerSearch: 8,
    maxFetchesPerSearch: 3,
    maxIterations: 2,
    coverageThreshold: 0.75,
    noveltyThreshold: 0.15,
    maxDurationMs: 2 * 60 * 1000, // 2 分钟
    maxSearchCalls: 15,
    maxPageFetches: 30,
  },
  deep: {
    parallelSearches: 6,
    resultsPerSearch: 10,
    maxFetchesPerSearch: 4,
    maxIterations: 4,
    coverageThreshold: 0.85,
    noveltyThreshold: 0.2,
    maxDurationMs: 5 * 60 * 1000, // 5 分钟
    maxSearchCalls: 30,
    maxPageFetches: 50,
  },
};

/**
 * 意图到报告风格的默认映射
 */
const INTENT_REPORT_STYLE: Record<string, ReportStyle> = {
  analysis: 'academic',
  comparison: 'default',
  current_events: 'news',
  technical_deep_dive: 'academic',
  multi_faceted: 'academic',
  explanation: 'popular_science',
  simple_lookup: 'default',
  factual_question: 'default',
  code_task: 'default',
  creative_task: 'default',
};

// ----------------------------------------------------------------------------
// Adaptive Config Generator
// ----------------------------------------------------------------------------

/**
 * 默认用户设置
 */
const DEFAULT_USER_SETTINGS: ResearchUserSettings = {
  autoDetect: true,
  confirmBeforeStart: false,
  preferredSources: [],
  defaultDepth: 'standard',
  maxDurationMinutes: 3,
  reportStyle: 'default',
};

/**
 * 自适应配置生成器
 *
 * 负责：
 * 1. 根据意图分类生成研究配置
 * 2. 应用用户偏好设置
 * 3. 调整配置以适应可用资源
 */
export class AdaptiveConfigGenerator {
  private userSettings: ResearchUserSettings;

  constructor(userSettings: Partial<ResearchUserSettings> = {}) {
    this.userSettings = { ...DEFAULT_USER_SETTINGS, ...userSettings };
  }

  /**
   * 根据意图分类生成研究配置
   *
   * @param classification - 意图分类结果
   * @param availableSources - 可用的数据源列表
   * @returns 研究配置
   */
  generateConfig(
    classification: IntentClassification,
    availableSources: DataSourceType[] = []
  ): AdaptiveResearchConfig {
    const { suggestedDepth, suggestedSources, intent, confidence } = classification;

    // 1. 获取基础预设
    const depth = this.resolveDepth(suggestedDepth, confidence);
    const preset = DEPTH_PRESETS[depth];

    // 2. 确定数据源
    const enabledSources = this.resolveEnabledSources(suggestedSources, availableSources);

    // 3. 确定报告风格
    const reportStyle = this.resolveReportStyle(intent);

    // 4. 应用用户设置调整
    const adjustedConfig = this.applyUserSettings(preset, enabledSources, reportStyle);

    // 5. 根据置信度微调
    const finalConfig = this.adjustByConfidence(adjustedConfig, confidence);

    logger.info('Generated adaptive config:', {
      intent,
      depth,
      confidence,
      sources: finalConfig.enabledSources,
      maxIterations: finalConfig.maxIterations,
    });

    return finalConfig;
  }

  /**
   * 快速生成配置（不检查可用性）
   */
  generateQuickConfig(depth: ResearchDepth): AdaptiveResearchConfig {
    const preset = DEPTH_PRESETS[depth];
    return {
      ...preset,
      enabledSources: ['web_search'],
      reportStyle: this.userSettings.reportStyle,
    };
  }

  /**
   * 解析最终深度（考虑用户默认设置）
   */
  private resolveDepth(suggestedDepth: ResearchDepth, confidence: number): ResearchDepth {
    // 低置信度时使用用户默认深度
    if (confidence < 0.6) {
      return this.userSettings.defaultDepth;
    }

    // 置信度中等时，取建议和默认的较大值
    if (confidence < 0.8) {
      const depthOrder: ResearchDepth[] = ['quick', 'standard', 'deep'];
      const suggestedIndex = depthOrder.indexOf(suggestedDepth);
      const defaultIndex = depthOrder.indexOf(this.userSettings.defaultDepth);
      return depthOrder[Math.max(suggestedIndex, defaultIndex)];
    }

    // 高置信度直接使用建议深度
    return suggestedDepth;
  }

  /**
   * 解析启用的数据源
   */
  private resolveEnabledSources(
    suggestedSources: DataSourceType[],
    availableSources: DataSourceType[]
  ): DataSourceType[] {
    // 合并建议源和用户偏好源
    const candidateSources = new Set<DataSourceType>([
      ...suggestedSources,
      ...this.userSettings.preferredSources,
    ]);

    // 如果提供了可用源列表，过滤不可用的
    if (availableSources.length > 0) {
      const availableSet = new Set(availableSources);
      const filteredSources = [...candidateSources].filter(s => availableSet.has(s));

      // 确保至少有 web_search
      if (filteredSources.length === 0) {
        return availableSources.includes('web_search') ? ['web_search'] : availableSources.slice(0, 1);
      }
      return filteredSources;
    }

    // 无可用源信息时，返回候选源
    return candidateSources.size > 0 ? [...candidateSources] : ['web_search'];
  }

  /**
   * 解析报告风格
   */
  private resolveReportStyle(intent: string): ReportStyle {
    // 用户设置优先
    if (this.userSettings.reportStyle !== 'default') {
      return this.userSettings.reportStyle;
    }
    // 否则使用意图对应的默认风格
    return INTENT_REPORT_STYLE[intent] ?? 'default';
  }

  /**
   * 应用用户设置
   */
  private applyUserSettings(
    preset: DepthPreset,
    enabledSources: DataSourceType[],
    reportStyle: ReportStyle
  ): AdaptiveResearchConfig {
    // 用户设置的最大时间限制
    const userMaxDurationMs = this.userSettings.maxDurationMinutes * 60 * 1000;
    const maxDurationMs = Math.min(preset.maxDurationMs, userMaxDurationMs);

    // 如果时间被缩短，相应调整其他参数
    const timeRatio = maxDurationMs / preset.maxDurationMs;
    const adjustedSearchCalls = Math.max(3, Math.floor(preset.maxSearchCalls * timeRatio));
    const adjustedPageFetches = Math.max(5, Math.floor(preset.maxPageFetches * timeRatio));

    return {
      parallelSearches: preset.parallelSearches,
      resultsPerSearch: preset.resultsPerSearch,
      maxFetchesPerSearch: preset.maxFetchesPerSearch,
      maxIterations: preset.maxIterations,
      coverageThreshold: preset.coverageThreshold,
      noveltyThreshold: preset.noveltyThreshold,
      maxDurationMs,
      maxSearchCalls: adjustedSearchCalls,
      maxPageFetches: adjustedPageFetches,
      enabledSources,
      reportStyle,
    };
  }

  /**
   * 根据置信度微调配置
   *
   * 低置信度 → 保守配置（少搜索，早停止）
   * 高置信度 → 激进配置（多搜索，深挖掘）
   */
  private adjustByConfidence(
    config: AdaptiveResearchConfig,
    confidence: number
  ): AdaptiveResearchConfig {
    // 置信度系数：0.5 -> 0.8x, 1.0 -> 1.2x
    const factor = 0.6 + confidence * 0.6;

    return {
      ...config,
      // 低置信度时减少搜索次数
      maxSearchCalls: Math.round(config.maxSearchCalls * factor),
      maxPageFetches: Math.round(config.maxPageFetches * factor),
      // 低置信度时降低覆盖度阈值（更容易停止）
      coverageThreshold: config.coverageThreshold * (0.9 + confidence * 0.1),
    };
  }

  /**
   * 更新用户设置
   */
  updateUserSettings(settings: Partial<ResearchUserSettings>): void {
    this.userSettings = { ...this.userSettings, ...settings };
  }

  /**
   * 获取当前用户设置
   */
  getUserSettings(): ResearchUserSettings {
    return { ...this.userSettings };
  }

  /**
   * 估算研究时间（用于 UI 显示）
   */
  estimateResearchTime(config: AdaptiveResearchConfig): {
    minSeconds: number;
    maxSeconds: number;
    description: string;
  } {
    // 基于配置参数估算
    const avgSearchTime = 3; // 秒
    const avgFetchTime = 2; // 秒

    const minSeconds = Math.ceil(
      (config.maxSearchCalls * avgSearchTime) / config.parallelSearches +
      (config.maxPageFetches * avgFetchTime) / 5
    ) * 0.5; // 最小估计

    const maxSeconds = Math.min(
      config.maxDurationMs / 1000,
      minSeconds * 2
    );

    let description: string;
    if (maxSeconds <= 30) {
      description = '快速查询';
    } else if (maxSeconds <= 120) {
      description = '标准研究';
    } else {
      description = '深度研究';
    }

    return { minSeconds, maxSeconds, description };
  }
}

// ----------------------------------------------------------------------------
// 便捷函数
// ----------------------------------------------------------------------------

/**
 * 创建自适应配置生成器的便捷函数
 */
export function createAdaptiveConfigGenerator(
  userSettings?: Partial<ResearchUserSettings>
): AdaptiveConfigGenerator {
  return new AdaptiveConfigGenerator(userSettings);
}

/**
 * 快速获取特定深度的预设配置
 */
export function getDepthPreset(depth: ResearchDepth): DepthPreset {
  return { ...DEPTH_PRESETS[depth] };
}

/**
 * 判断配置是否需要深度研究
 */
export function isDeepResearchConfig(config: AdaptiveResearchConfig): boolean {
  return config.maxIterations > 1 || config.maxSearchCalls > 10;
}
