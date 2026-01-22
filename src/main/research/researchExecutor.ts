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
    };
  }

  /**
   * 执行完整的研究计划
   *
   * @param plan - 研究计划
   * @returns 执行后的计划（包含每步结果）
   */
  async execute(plan: ResearchPlan): Promise<ResearchPlan> {
    logger.info('Executing research plan:', {
      topic: plan.clarifiedTopic,
      stepsCount: plan.steps.length,
    });

    const updatedPlan: ResearchPlan = {
      ...plan,
      steps: [...plan.steps],
    };

    for (let i = 0; i < updatedPlan.steps.length; i++) {
      const step = { ...updatedPlan.steps[i] };
      updatedPlan.steps[i] = step;

      // 更新状态为运行中
      step.status = 'running';
      this.onProgress(step, (i / updatedPlan.steps.length) * 100);

      logger.info(`Executing step ${i + 1}/${updatedPlan.steps.length}:`, step.title);

      try {
        const result = await this.executeStep(step, updatedPlan);
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

        // 继续执行后续步骤（非阻塞）
      }

      this.onProgress(step, ((i + 1) / updatedPlan.steps.length) * 100);
    }

    logger.info('Research plan execution completed:', {
      completed: updatedPlan.steps.filter(s => s.status === 'completed').length,
      failed: updatedPlan.steps.filter(s => s.status === 'failed').length,
    });

    return updatedPlan;
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
   */
  private async executeResearchStep(step: ResearchStep): Promise<string> {
    const results: string[] = [];
    const queries = (step.searchQueries ?? []).slice(0, this.config.maxSearchPerStep);

    logger.info('Executing research step with queries:', queries);

    for (const query of queries) {
      try {
        // 执行网络搜索
        const searchResult = await this.toolExecutor.execute(
          'web_search',
          { query, count: 5 },
          { generation: this.config.generation }
        );

        if (searchResult.success && searchResult.result) {
          const searchOutput = typeof searchResult.result === 'string'
            ? searchResult.result
            : JSON.stringify(searchResult.result);

          results.push(`## 搜索: ${query}\n${searchOutput}`);

          // 提取 URL 并抓取页面内容
          const urls = this.extractUrls(searchOutput).slice(0, this.config.maxFetchPerSearch);

          for (const url of urls) {
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
                results.push(`### 来源: ${url}\n${truncatedContent}${content.length > this.config.maxFetchContentLength ? '\n[内容已截断...]' : ''}`);
              }
            } catch (fetchError) {
              // 忽略单个页面抓取失败
              logger.debug('Failed to fetch URL:', url);
            }
          }
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push(`搜索失败 [${query}]: ${errorMessage}`);
        logger.warn('Search failed for query:', query, errorMessage);
      }
    }

    if (results.length === 0) {
      return `未能获取到关于"${step.title}"的相关信息，请检查网络连接或尝试其他搜索关键词。`;
    }

    return results.join('\n\n');
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
