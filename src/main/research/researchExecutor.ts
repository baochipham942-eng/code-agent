// ============================================================================
// Research Executor - 研究步骤执行器
// 负责执行研究计划中的各类步骤
// ============================================================================

import type {
  ResearchPlan,
  ResearchStep,
  ResearchStepType,
} from './types';
import type { ModelRouter } from '../model/modelRouter';
import type { ToolExecutor } from '../tools/toolExecutor';
import type { Generation } from '../../shared/types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ResearchExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 进度回调函数类型
 */
export type ProgressCallback = (
  step: ResearchStep,
  stepPercent: number
) => void;

/**
 * 执行器配置
 */
export interface ResearchExecutorConfig {
  /** 每步最大搜索次数 */
  maxSearchPerStep?: number;
  /** 每个搜索结果最大抓取页面数 */
  maxFetchPerSearch?: number;
  /** 抓取内容最大长度 */
  maxFetchContentLength?: number;
  /** 当前代际配置（可选，会使用默认 Gen4 配置） */
  generation?: Generation;
  /** 并行搜索的最大并发数，默认 3 */
  maxConcurrentSearches?: number;
  /** 并行抓取的最大并发数，默认 5 */
  maxConcurrentFetches?: number;
  /** 启用步骤级并行（独立 research 步骤并行执行），默认 true */
  enableStepParallelism?: boolean;
}

/**
 * 默认 Generation 配置（用于深度研究模式）
 */
const DEFAULT_GENERATION: Generation = {
  id: 'gen4',
  name: 'Gen 4',
  version: '4.0.0',
  description: 'Deep Research Mode',
  tools: ['web_search', 'web_fetch'],
  systemPrompt: '',
  promptMetadata: { lineCount: 0, toolCount: 2, ruleCount: 0 },
};

// ----------------------------------------------------------------------------
// Research Executor
// ----------------------------------------------------------------------------

/**
 * 研究执行器
 *
 * 负责执行研究计划中的步骤：
 * - research: 网络搜索 + 内容抓取
 * - analysis: 纯 LLM 推理分析
 * - processing: 代码执行（当前简化为分析）
 */
export class ResearchExecutor {
  private toolExecutor: ToolExecutor;
  private modelRouter: ModelRouter;
  private onProgress: ProgressCallback;
  private config: Required<ResearchExecutorConfig>;

  constructor(
    toolExecutor: ToolExecutor,
    modelRouter: ModelRouter,
    onProgress?: ProgressCallback,
    config: ResearchExecutorConfig = {}
  ) {
    this.toolExecutor = toolExecutor;
    this.modelRouter = modelRouter;
    this.onProgress = onProgress ?? (() => {});
    this.config = {
      maxSearchPerStep: config.maxSearchPerStep ?? 3,
      maxFetchPerSearch: config.maxFetchPerSearch ?? 3,
      maxFetchContentLength: config.maxFetchContentLength ?? 3000,
      generation: config.generation ?? DEFAULT_GENERATION,
      maxConcurrentSearches: config.maxConcurrentSearches ?? 3,
      maxConcurrentFetches: config.maxConcurrentFetches ?? 5,
      enableStepParallelism: config.enableStepParallelism ?? true,
    };
  }

  /**
   * 执行完整的研究计划
   *
   * 优化策略：
   * 1. 独立的 research 步骤可以并行执行
   * 2. analysis/processing 步骤依赖前序结果，必须串行
   * 3. 同一批并行步骤完成后，才能执行下一批
   *
   * @param plan - 研究计划
   * @returns 执行后的计划（包含每步结果）
   */
  async execute(plan: ResearchPlan): Promise<ResearchPlan> {
    logger.info('Executing research plan:', {
      topic: plan.clarifiedTopic,
      stepsCount: plan.steps.length,
      parallelEnabled: this.config.enableStepParallelism,
    });

    const updatedPlan: ResearchPlan = {
      ...plan,
      steps: plan.steps.map(s => ({ ...s })),
    };

    if (this.config.enableStepParallelism) {
      await this.executeWithParallelism(updatedPlan);
    } else {
      await this.executeSequentially(updatedPlan);
    }

    logger.info('Research plan execution completed:', {
      completed: updatedPlan.steps.filter(s => s.status === 'completed').length,
      failed: updatedPlan.steps.filter(s => s.status === 'failed').length,
    });

    return updatedPlan;
  }

  /**
   * 串行执行所有步骤（原始逻辑）
   */
  private async executeSequentially(plan: ResearchPlan): Promise<void> {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      await this.executeSingleStep(step, plan, i, plan.steps.length);
    }
  }

  /**
   * 并行执行优化
   *
   * 策略：将步骤分成多个批次
   * - 批次 1: 所有独立的 research 步骤（并行）
   * - 批次 2+: analysis/processing 步骤（串行，因为依赖前序结果）
   */
  private async executeWithParallelism(plan: ResearchPlan): Promise<void> {
    // 分离独立的 research 步骤和依赖步骤
    const independentResearchSteps: number[] = [];
    const dependentSteps: number[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.stepType === 'research') {
        independentResearchSteps.push(i);
      } else {
        dependentSteps.push(i);
      }
    }

    logger.info('Parallel execution plan:', {
      independentResearch: independentResearchSteps.length,
      dependent: dependentSteps.length,
    });

    // 批次 1: 并行执行所有独立的 research 步骤
    if (independentResearchSteps.length > 0) {
      logger.info(`Executing ${independentResearchSteps.length} research steps in parallel`);

      // 更新所有 research 步骤状态为 running
      for (const idx of independentResearchSteps) {
        plan.steps[idx].status = 'running';
        this.onProgress(plan.steps[idx], (idx / plan.steps.length) * 100);
      }

      // 并行执行
      const researchPromises = independentResearchSteps.map(async (idx) => {
        const step = plan.steps[idx];
        try {
          logger.info(`[Parallel] Executing research step: ${step.title}`);
          const result = await this.executeStep(step, plan);
          step.result = result;
          step.status = 'completed';
          logger.info(`[Parallel] Step completed: ${step.id}`);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          step.error = errorMessage;
          step.status = 'failed';
          logger.error(`[Parallel] Step failed: ${step.id}`, errorMessage);
        }
        this.onProgress(step, ((idx + 1) / plan.steps.length) * 100);
      });

      await Promise.all(researchPromises);
    }

    // 批次 2+: 串行执行依赖步骤（analysis/processing）
    for (const idx of dependentSteps) {
      const step = plan.steps[idx];
      await this.executeSingleStep(step, plan, idx, plan.steps.length);
    }
  }

  /**
   * 执行单个步骤（带状态更新和日志）
   */
  private async executeSingleStep(
    step: ResearchStep,
    plan: ResearchPlan,
    index: number,
    total: number
  ): Promise<void> {
    step.status = 'running';
    this.onProgress(step, (index / total) * 100);

    logger.info(`Executing step ${index + 1}/${total}:`, step.title);

    try {
      const result = await this.executeStep(step, plan);
      step.result = result;
      step.status = 'completed';

      logger.info(`Step completed:`, {
        id: step.id,
        resultLength: result.length,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      step.error = errorMessage;
      step.status = 'failed';

      logger.error(`Step failed:`, {
        id: step.id,
        error: errorMessage,
      });
    }

    this.onProgress(step, ((index + 1) / total) * 100);
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(
    step: ResearchStep,
    plan: ResearchPlan
  ): Promise<string> {
    switch (step.stepType) {
      case 'research':
        return await this.executeResearchStep(step);
      case 'analysis':
        return await this.executeAnalysisStep(step, plan);
      case 'processing':
        return await this.executeProcessingStep(step, plan);
      default:
        throw new Error(`Unknown step type: ${step.stepType}`);
    }
  }

  /**
   * 执行研究步骤（网络搜索 + 内容抓取）
   *
   * 优化：搜索和抓取都并行执行
   * - 多个搜索查询并行发起
   * - 每个搜索结果的 URL 并行抓取
   */
  private async executeResearchStep(step: ResearchStep): Promise<string> {
    const queries = (step.searchQueries ?? []).slice(0, this.config.maxSearchPerStep);

    logger.info('Executing research step with queries (parallel):', {
      queries,
      maxConcurrentSearches: this.config.maxConcurrentSearches,
      maxConcurrentFetches: this.config.maxConcurrentFetches,
    });

    // 并行执行所有搜索查询（使用 allSettled 实现错误隔离）
    const searchPromises = queries.map(query => this.executeSearchWithFetch(query));
    const searchSettled = await Promise.allSettled(searchPromises);

    // 合并成功的结果，失败的记录日志但不阻断整体流程
    const searchResults: string[][] = [];
    for (let i = 0; i < searchSettled.length; i++) {
      const result = searchSettled[i];
      if (result.status === 'fulfilled') {
        searchResults.push(result.value);
      } else {
        logger.warn(`Search query failed: ${queries[i]}`, result.reason);
        searchResults.push([`搜索失败 [${queries[i]}]: ${result.reason?.message || '未知错误'}`]);
      }
    }

    // 合并结果
    const results = searchResults.flat().filter(r => r.length > 0);

    if (results.length === 0) {
      return `未能获取到关于"${step.title}"的相关信息，请检查网络连接或尝试其他搜索关键词。`;
    }

    return results.join('\n\n');
  }

  /**
   * 执行单个搜索查询并抓取相关页面
   */
  private async executeSearchWithFetch(query: string): Promise<string[]> {
    const results: string[] = [];

    try {
      // 执行网络搜索
      const searchResult = await this.toolExecutor.execute(
        'web_search',
        { query, count: 5 },
        { generation: this.config.generation }
      );

      if (!searchResult.success || !searchResult.result) {
        results.push(`搜索失败 [${query}]: ${searchResult.error ?? '无结果'}`);
        return results;
      }

      const searchOutput = typeof searchResult.result === 'string'
        ? searchResult.result
        : JSON.stringify(searchResult.result);

      results.push(`## 搜索: ${query}\n${searchOutput}`);

      // 提取 URL 并并行抓取页面内容（使用 allSettled 实现错误隔离）
      const urls = this.extractUrls(searchOutput).slice(0, this.config.maxFetchPerSearch);

      if (urls.length > 0) {
        const fetchPromises = urls.map(url => this.fetchUrl(url));
        const fetchSettled = await Promise.allSettled(fetchPromises);

        for (let i = 0; i < fetchSettled.length; i++) {
          const result = fetchSettled[i];
          if (result.status === 'fulfilled' && result.value) {
            results.push(result.value);
          } else if (result.status === 'rejected') {
            // 单个页面抓取失败不影响其他页面
            logger.debug(`Fetch failed for URL: ${urls[i]}`, result.reason);
          }
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push(`搜索失败 [${query}]: ${errorMessage}`);
      logger.warn('Search failed for query:', query, errorMessage);
    }

    return results;
  }

  /**
   * 抓取单个 URL 内容
   */
  private async fetchUrl(url: string): Promise<string | null> {
    try {
      const fetchResult = await this.toolExecutor.execute(
        'web_fetch',
        { url },
        { generation: this.config.generation }
      );

      if (fetchResult.success && fetchResult.result) {
        const content = typeof fetchResult.result === 'string'
          ? fetchResult.result
          : JSON.stringify(fetchResult.result);

        // 截取内容长度
        const truncatedContent = content.slice(0, this.config.maxFetchContentLength);
        return `### 来源: ${url}\n${truncatedContent}${content.length > this.config.maxFetchContentLength ? '\n[内容已截断...]' : ''}`;
      }
    } catch (fetchError) {
      // 忽略单个页面抓取失败
      logger.debug('Failed to fetch URL:', url);
    }
    return null;
  }

  /**
   * 执行分析步骤（纯 LLM 推理）
   */
  private async executeAnalysisStep(
    step: ResearchStep,
    plan: ResearchPlan
  ): Promise<string> {
    // 收集前序步骤的结果
    const previousResults = plan.steps
      .filter(s => s.status === 'completed' && s.result)
      .map(s => `### ${s.title}\n${s.result}`)
      .join('\n\n');

    if (!previousResults) {
      return `无法执行分析：没有可用的前序步骤结果。`;
    }

    const analysisPrompt = `基于以下已收集的信息，完成分析任务。

## 研究主题
${plan.clarifiedTopic}

## 当前分析任务
${step.title}: ${step.description}

## 已收集信息
${previousResults}

## 要求
1. 基于事实进行分析，不要编造信息
2. 引用具体数据和来源
3. 保持客观中立
4. 输出结构化的分析结果
5. 如果信息不足，明确指出需要补充的内容

请直接输出分析结果：`;

    try {
      const response = await this.modelRouter.chat({
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: analysisPrompt }],
        maxTokens: 2000,
      });

      return response.content ?? '分析结果为空';
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`分析失败: ${errorMessage}`);
    }
  }

  /**
   * 执行处理步骤（代码执行）
   * 当前简化实现：转换为分析步骤
   */
  private async executeProcessingStep(
    step: ResearchStep,
    plan: ResearchPlan
  ): Promise<string> {
    // 当前简化实现：将处理请求转换为 LLM 分析
    // 未来可扩展为真实代码执行（如数据处理、图表生成等）
    logger.info('Processing step converted to analysis:', step.id);
    return await this.executeAnalysisStep(step, plan);
  }

  /**
   * 从文本中提取 URL
   */
  private extractUrls(text: string): string[] {
    const urlPattern = /https?:\/\/[^\s\)\]\>\"\']+/g;
    const matches = text.match(urlPattern) ?? [];

    // 去重并过滤无效 URL
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
}
