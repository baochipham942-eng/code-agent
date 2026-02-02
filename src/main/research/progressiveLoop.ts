// ============================================================================
// Progressive Research Loop - 渐进式研究循环
// ReAct 风格的迭代研究：计划 → 执行 → 观察 → 更新
// ============================================================================

import type {
  AdaptiveResearchConfig,
  ProgressiveResearchState,
  SourceResult,
  ExtractedFact,
  IdentifiedGap,
  StoppingAnalysis,
  StoppingReasonType,
  DataSourceType,
  EnhancedResearchProgress,
} from './types';
import type { ModelRouter } from '../model/modelRouter';
import type { ToolExecutor } from '../tools/toolExecutor';
import type { Generation } from '../../shared/types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProgressiveLoop');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 迭代计划
 */
interface IterationPlan {
  /** 搜索查询列表 */
  queries: string[];
  /** 目标数据源 */
  targetSources: DataSourceType[];
  /** 聚焦的信息空白 */
  focusGaps: IdentifiedGap[];
  /** 计划理由 */
  reasoning: string;
}

/**
 * 进度回调
 */
export type ProgressCallback = (progress: EnhancedResearchProgress) => void;

/**
 * 循环配置
 */
export interface ProgressiveLoopConfig {
  /** 研究配置 */
  researchConfig: AdaptiveResearchConfig;
  /** 当前代际 */
  generation?: Generation;
  /** 触发方式 */
  triggeredBy: 'semantic' | 'manual';
}

/**
 * 默认 Generation
 */
const DEFAULT_GENERATION: Generation = {
  id: 'gen4',
  name: 'Gen 4',
  version: '4.0.0',
  description: 'Progressive Research',
  tools: ['web_search', 'web_fetch'],
  systemPrompt: '',
  promptMetadata: { lineCount: 0, toolCount: 2, ruleCount: 0 },
};

// ----------------------------------------------------------------------------
// Progressive Research Loop
// ----------------------------------------------------------------------------

/**
 * 渐进式研究循环
 *
 * 实现 ReAct 风格的迭代研究：
 * 1. 计划（Plan）：根据当前状态生成下一步搜索计划
 * 2. 执行（Act）：并行执行搜索和内容抓取
 * 3. 观察（Observe）：提取事实、识别信息空白
 * 4. 更新（Update）：更新覆盖度和新颖度
 * 5. 判断（Decide）：检查停止条件
 */
export class ProgressiveResearchLoop {
  private toolExecutor: ToolExecutor;
  private modelRouter: ModelRouter;
  private config: ProgressiveLoopConfig;
  private generation: Generation;
  private onProgress?: ProgressCallback;

  constructor(
    toolExecutor: ToolExecutor,
    modelRouter: ModelRouter,
    config: ProgressiveLoopConfig,
    onProgress?: ProgressCallback
  ) {
    this.toolExecutor = toolExecutor;
    this.modelRouter = modelRouter;
    this.config = config;
    this.generation = config.generation ?? DEFAULT_GENERATION;
    this.onProgress = onProgress;
  }

  /**
   * 执行渐进式研究
   *
   * @param topic - 研究主题
   * @param objectives - 研究目标列表
   * @returns 最终研究状态
   */
  async execute(topic: string, objectives: string[]): Promise<ProgressiveResearchState> {
    // 初始化状态
    const state = this.initializeState(topic, objectives);

    logger.info('Starting progressive research loop:', {
      topic,
      objectives: objectives.length,
      maxIterations: this.config.researchConfig.maxIterations,
    });

    this.emitProgress(state, 'researching', '开始研究...');

    // 主循环
    while (true) {
      // 检查停止条件
      const stopping = this.checkStoppingConditions(state);
      if (stopping.shouldStop) {
        logger.info('Research loop stopping:', stopping);
        state.iteration--; // 回退迭代计数（因为未完成）
        break;
      }

      // 执行一次迭代
      await this.executeIteration(state);

      // 更新迭代计数
      state.iteration++;
    }

    this.emitProgress(state, 'complete', '研究完成');

    logger.info('Progressive research completed:', {
      iterations: state.iteration,
      sourcesCount: state.sources.length,
      factsCount: state.facts.length,
      coverage: state.overallCoverage,
    });

    return state;
  }

  /**
   * 初始化研究状态
   */
  private initializeState(topic: string, objectives: string[]): ProgressiveResearchState {
    const objectivesCovered = new Map<string, number>();
    for (const obj of objectives) {
      objectivesCovered.set(obj, 0);
    }

    return {
      topic,
      iteration: 1,
      sources: [],
      facts: [],
      gaps: objectives.map((obj, i) => ({
        description: obj,
        relatedObjective: obj,
        suggestedQueries: [],
        priority: objectives.length - i, // 越靠前优先级越高
      })),
      objectivesCovered,
      overallCoverage: 0,
      lastIterationNovelty: 1.0,
      totalUniqueInfo: 0,
      searchCallsUsed: 0,
      pageFetchesUsed: 0,
      timeElapsedMs: 0,
      startTime: Date.now(),
    };
  }

  /**
   * 执行单次迭代
   */
  private async executeIteration(state: ProgressiveResearchState): Promise<void> {
    const iterationStart = Date.now();

    logger.info(`Starting iteration ${state.iteration}/${this.config.researchConfig.maxIterations}`);
    this.emitProgress(state, 'researching', `第 ${state.iteration} 轮研究中...`);

    // 1. 生成迭代计划
    const plan = await this.planIteration(state);
    logger.info('Iteration plan generated:', {
      queries: plan.queries.length,
      sources: plan.targetSources,
    });

    // 2. 执行搜索
    const searchResults = await this.executeSearches(state, plan);
    logger.info('Search completed:', { resultsCount: searchResults.length });

    // 3. 分析结果
    const analysis = await this.analyzeResults(state, searchResults);
    logger.info('Analysis completed:', {
      newFacts: analysis.newFacts.length,
      newGaps: analysis.newGaps.length,
    });

    // 4. 更新状态
    this.updateState(state, searchResults, analysis);

    // 更新时间
    state.timeElapsedMs = Date.now() - state.startTime;

    logger.info(`Iteration ${state.iteration} completed:`, {
      duration: Date.now() - iterationStart,
      coverage: state.overallCoverage,
      novelty: state.lastIterationNovelty,
    });
  }

  /**
   * 生成迭代计划
   */
  private async planIteration(state: ProgressiveResearchState): Promise<IterationPlan> {
    const { researchConfig } = this.config;

    // 第一次迭代：基于主题生成初始查询
    if (state.iteration === 1) {
      return this.generateInitialPlan(state);
    }

    // 后续迭代：基于信息空白生成查询
    return this.generateGapFillingPlan(state);
  }

  /**
   * 生成初始计划
   */
  private async generateInitialPlan(state: ProgressiveResearchState): Promise<IterationPlan> {
    const { researchConfig } = this.config;

    // 使用 LLM 生成初始搜索查询
    const prompt = `为以下研究主题生成 ${researchConfig.parallelSearches} 个搜索查询：

主题: ${state.topic}

研究目标:
${[...state.objectivesCovered.keys()].map((o, i) => `${i + 1}. ${o}`).join('\n')}

要求:
1. 每个查询覆盖不同角度
2. 使用精确、具体的关键词
3. 包含中文和英文查询（如果适用）
4. 优先覆盖高优先级目标

请以 JSON 数组格式输出查询列表：
["查询1", "查询2", ...]`;

    try {
      const response = await this.modelRouter.chat({
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
      });

      const jsonMatch = response.content?.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const queries = JSON.parse(jsonMatch[0]) as string[];
          return {
            queries: queries.slice(0, researchConfig.parallelSearches),
            targetSources: researchConfig.enabledSources,
            focusGaps: state.gaps.slice(0, 3),
            reasoning: '初始研究，覆盖主要研究目标',
          };
        } catch (parseError) {
          logger.warn('Failed to parse initial plan JSON:', { error: parseError, raw: jsonMatch[0].slice(0, 200) });
        }
      }
    } catch (error) {
      logger.warn('Failed to generate initial plan via LLM:', error);
    }

    // 回退：基于主题和目标生成简单查询
    const fallbackQueries = [
      state.topic,
      ...state.gaps.slice(0, researchConfig.parallelSearches - 1).map(g => g.description),
    ];

    return {
      queries: fallbackQueries,
      targetSources: researchConfig.enabledSources,
      focusGaps: state.gaps.slice(0, 3),
      reasoning: '使用默认查询策略',
    };
  }

  /**
   * 生成空白填补计划
   */
  private async generateGapFillingPlan(state: ProgressiveResearchState): Promise<IterationPlan> {
    const { researchConfig } = this.config;

    // 找出未充分覆盖的目标
    const uncoveredObjectives = [...state.objectivesCovered.entries()]
      .filter(([_, coverage]) => coverage < researchConfig.coverageThreshold)
      .sort((a, b) => a[1] - b[1]) // 覆盖度低的优先
      .map(([obj]) => obj);

    // 优先处理高优先级的信息空白
    const priorityGaps = state.gaps
      .filter(g => g.priority >= 3)
      .slice(0, researchConfig.parallelSearches);

    // 生成查询
    const queries: string[] = [];

    // 从空白的建议查询中提取
    for (const gap of priorityGaps) {
      if (gap.suggestedQueries.length > 0) {
        queries.push(...gap.suggestedQueries.slice(0, 2));
      } else {
        queries.push(gap.description);
      }
    }

    // 补充未覆盖目标的查询
    for (const obj of uncoveredObjectives) {
      if (queries.length >= researchConfig.parallelSearches) break;
      if (!queries.includes(obj)) {
        queries.push(`${state.topic} ${obj}`);
      }
    }

    return {
      queries: queries.slice(0, researchConfig.parallelSearches),
      targetSources: researchConfig.enabledSources,
      focusGaps: priorityGaps,
      reasoning: `填补信息空白，聚焦 ${priorityGaps.length} 个高优先级问题`,
    };
  }

  /**
   * 执行搜索
   */
  private async executeSearches(
    state: ProgressiveResearchState,
    plan: IterationPlan
  ): Promise<SourceResult[]> {
    const { researchConfig } = this.config;
    const results: SourceResult[] = [];

    // 并行执行搜索
    const searchPromises = plan.queries.map(async (query) => {
      // 检查搜索预算
      if (state.searchCallsUsed >= researchConfig.maxSearchCalls) {
        return [];
      }

      try {
        state.searchCallsUsed++;

        const searchResult = await this.toolExecutor.execute(
          'web_search',
          { query, count: researchConfig.resultsPerSearch },
          { generation: this.generation }
        );

        if (!searchResult.success || !searchResult.result) {
          return [];
        }

        const searchOutput = typeof searchResult.result === 'string'
          ? searchResult.result
          : JSON.stringify(searchResult.result);

        // 提取 URL 并抓取
        const urls = this.extractUrls(searchOutput).slice(0, researchConfig.maxFetchesPerSearch);
        const fetchResults = await this.fetchUrls(state, urls);

        return fetchResults;
      } catch (error) {
        logger.warn('Search failed:', query, error);
        return [];
      }
    });

    const allResults = await Promise.all(searchPromises);
    for (const r of allResults) {
      results.push(...r);
    }

    return results;
  }

  /**
   * 抓取 URL 列表
   */
  private async fetchUrls(
    state: ProgressiveResearchState,
    urls: string[]
  ): Promise<SourceResult[]> {
    const { researchConfig } = this.config;
    const results: SourceResult[] = [];

    const fetchPromises = urls.map(async (url) => {
      // 检查抓取预算
      if (state.pageFetchesUsed >= researchConfig.maxPageFetches) {
        return null;
      }

      try {
        state.pageFetchesUsed++;

        const fetchResult = await this.toolExecutor.execute(
          'web_fetch',
          { url },
          { generation: this.generation }
        );

        if (!fetchResult.success || !fetchResult.result) {
          return null;
        }

        const content = typeof fetchResult.result === 'string'
          ? fetchResult.result
          : JSON.stringify(fetchResult.result);

        return {
          url,
          title: this.extractTitle(content) || url,
          sourceType: 'web_search' as DataSourceType,
          content: content.slice(0, 3000), // 截断
          fetchedAt: Date.now(),
        };
      } catch (error) {
        logger.debug('Fetch failed:', url);
        return null;
      }
    });

    const fetchResults = await Promise.all(fetchPromises);
    for (const r of fetchResults) {
      if (r) results.push(r);
    }

    return results;
  }

  /**
   * 分析搜索结果
   */
  private async analyzeResults(
    state: ProgressiveResearchState,
    sources: SourceResult[]
  ): Promise<{ newFacts: ExtractedFact[]; newGaps: IdentifiedGap[] }> {
    if (sources.length === 0) {
      return { newFacts: [], newGaps: [] };
    }

    // 构建分析 prompt
    const sourceSummaries = sources
      .map(s => `来源: ${s.url}\n内容摘要: ${s.content.slice(0, 500)}`)
      .join('\n\n');

    const objectives = [...state.objectivesCovered.keys()];

    const prompt = `分析以下搜索结果，提取关键事实并识别信息空白。

研究主题: ${state.topic}

研究目标:
${objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}

搜索结果:
${sourceSummaries}

请输出 JSON 格式的分析结果：
{
  "facts": [
    {"content": "事实内容", "sourceUrl": "来源URL", "relatedObjective": "相关目标", "confidence": 0.8}
  ],
  "gaps": [
    {"description": "信息空白描述", "relatedObjective": "相关目标", "suggestedQueries": ["建议查询"], "priority": 3}
  ],
  "objectiveCoverage": {
    "目标1": 0.5,
    "目标2": 0.3
  }
}`;

    try {
      const response = await this.modelRouter.chat({
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1000,
      });

      const jsonMatch = response.content?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const analysis = JSON.parse(jsonMatch[0]) as {
            facts: ExtractedFact[];
            gaps: IdentifiedGap[];
            objectiveCoverage: Record<string, number>;
          };

          // 更新目标覆盖度
          for (const [obj, coverage] of Object.entries(analysis.objectiveCoverage)) {
            const current = state.objectivesCovered.get(obj) ?? 0;
            state.objectivesCovered.set(obj, Math.max(current, coverage));
          }

          return {
            newFacts: analysis.facts ?? [],
            newGaps: analysis.gaps ?? [],
          };
        } catch (parseError) {
          logger.warn('Failed to parse analysis JSON:', { error: parseError, raw: jsonMatch[0].slice(0, 200) });
        }
      }
    } catch (error) {
      logger.warn('Failed to analyze results via LLM:', error);
    }

    return { newFacts: [], newGaps: [] };
  }

  /**
   * 更新状态
   */
  private updateState(
    state: ProgressiveResearchState,
    sources: SourceResult[],
    analysis: { newFacts: ExtractedFact[]; newGaps: IdentifiedGap[] }
  ): void {
    // 添加新来源（去重）
    const existingUrls = new Set(state.sources.map(s => s.url));
    for (const source of sources) {
      if (!existingUrls.has(source.url)) {
        state.sources.push(source);
        existingUrls.add(source.url);
      }
    }

    // 计算新颖度（新事实占比）
    const previousFactCount = state.facts.length;
    state.facts.push(...analysis.newFacts);
    state.lastIterationNovelty = analysis.newFacts.length > 0
      ? analysis.newFacts.length / Math.max(1, sources.length)
      : 0;

    // 更新信息空白
    state.gaps = [
      ...analysis.newGaps,
      ...state.gaps.filter(g => g.priority > 0),
    ].slice(0, 10); // 保留最多 10 个空白

    // 计算整体覆盖度
    const coverages = [...state.objectivesCovered.values()];
    state.overallCoverage = coverages.length > 0
      ? coverages.reduce((sum, c) => sum + c, 0) / coverages.length
      : 0;

    // 更新唯一信息量
    state.totalUniqueInfo += analysis.newFacts.length;
  }

  /**
   * 检查停止条件
   */
  private checkStoppingConditions(state: ProgressiveResearchState): StoppingAnalysis {
    const { researchConfig } = this.config;

    // 1. 覆盖度达标
    if (state.overallCoverage >= researchConfig.coverageThreshold) {
      return {
        shouldStop: true,
        reason: 'coverage',
        details: `覆盖度达到 ${(state.overallCoverage * 100).toFixed(1)}%`,
        canContinue: true,
      };
    }

    // 2. 新颖度枯竭（连续低新颖度）
    if (state.iteration > 1 && state.lastIterationNovelty < researchConfig.noveltyThreshold) {
      return {
        shouldStop: true,
        reason: 'novelty_exhausted',
        details: `新颖度降至 ${(state.lastIterationNovelty * 100).toFixed(1)}%`,
        canContinue: true,
      };
    }

    // 3. 搜索预算耗尽
    if (state.searchCallsUsed >= researchConfig.maxSearchCalls) {
      return {
        shouldStop: true,
        reason: 'budget_search',
        details: `已用搜索次数 ${state.searchCallsUsed}/${researchConfig.maxSearchCalls}`,
        canContinue: false,
      };
    }

    // 4. 抓取预算耗尽
    if (state.pageFetchesUsed >= researchConfig.maxPageFetches) {
      return {
        shouldStop: true,
        reason: 'budget_fetch',
        details: `已抓取页面 ${state.pageFetchesUsed}/${researchConfig.maxPageFetches}`,
        canContinue: false,
      };
    }

    // 5. 时间预算耗尽
    state.timeElapsedMs = Date.now() - state.startTime;
    if (state.timeElapsedMs >= researchConfig.maxDurationMs) {
      return {
        shouldStop: true,
        reason: 'budget_time',
        details: `已用时间 ${Math.round(state.timeElapsedMs / 1000)}s`,
        canContinue: false,
      };
    }

    // 6. 迭代次数达限
    if (state.iteration > researchConfig.maxIterations) {
      return {
        shouldStop: true,
        reason: 'max_iterations',
        details: `已完成 ${state.iteration - 1} 轮迭代`,
        canContinue: true,
      };
    }

    return {
      shouldStop: false,
      reason: null,
      details: '',
      canContinue: true,
    };
  }

  /**
   * 发送进度事件
   */
  private emitProgress(
    state: ProgressiveResearchState,
    phase: 'planning' | 'researching' | 'reporting' | 'complete' | 'error',
    message: string
  ): void {
    if (!this.onProgress) return;

    const { researchConfig } = this.config;
    const percent = phase === 'complete'
      ? 100
      : Math.min(95, (state.iteration / researchConfig.maxIterations) * 80 + 10);

    this.onProgress({
      phase,
      message,
      percent,
      currentStep: {
        title: `迭代 ${state.iteration}/${researchConfig.maxIterations}`,
        status: phase === 'complete' ? 'completed' : 'running',
      },
      triggeredBy: this.config.triggeredBy,
      currentIteration: state.iteration,
      maxIterations: researchConfig.maxIterations,
      coverage: state.overallCoverage,
      activeSources: researchConfig.enabledSources,
      canDeepen: state.overallCoverage < researchConfig.coverageThreshold,
    });
  }

  /**
   * 从文本中提取 URL
   */
  private extractUrls(text: string): string[] {
    const urlPattern = /https?:\/\/[^\s\)\]\>\"\']+/g;
    const matches = text.match(urlPattern) ?? [];
    const uniqueUrls = [...new Set(matches)];
    return uniqueUrls.filter(url => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * 从内容中提取标题
   */
  private extractTitle(content: string): string | null {
    // 尝试从 Markdown 标题提取
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) return h1Match[1];

    // 尝试从 HTML title 提取
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) return titleMatch[1];

    return null;
  }
}

// ----------------------------------------------------------------------------
// 便捷函数
// ----------------------------------------------------------------------------

/**
 * 创建渐进式研究循环
 */
export function createProgressiveLoop(
  toolExecutor: ToolExecutor,
  modelRouter: ModelRouter,
  config: ProgressiveLoopConfig,
  onProgress?: ProgressCallback
): ProgressiveResearchLoop {
  return new ProgressiveResearchLoop(toolExecutor, modelRouter, config, onProgress);
}
