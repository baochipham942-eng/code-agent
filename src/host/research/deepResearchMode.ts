// ============================================================================
// Deep Research Mode - 深度研究模式主控制器
// 整合 ResearchPlanner、ResearchExecutor、ReportGenerator
// ============================================================================

import type {
  ResearchPlan,
  ResearchReport,
  ReportStyle,
  DeepResearchConfig,
  ResearchPhase,
  ResearchProgressData,
} from './types';
import type { AgentEvent } from '../../shared/contract';
import type { ModelRouter } from '../model/modelRouter';
import type { ToolExecutor } from '../tools/toolExecutor';
import { ResearchPlanner } from './researchPlanner';
import { ResearchExecutor } from './researchExecutor';
import { ReportGenerator } from './reportGenerator';
import { UrlCompressor } from './urlCompressor';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DeepResearchMode');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------



// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 深度研究模式配置
 */
export interface DeepResearchModeConfig {
  modelRouter: ModelRouter;
  toolExecutor: ToolExecutor;
  onEvent: (event: AgentEvent) => void;
}

/**
 * 深度研究结果
 */
export interface DeepResearchResult {
  success: boolean;
  report?: ResearchReport;
  plan?: ResearchPlan;
  error?: string;
  duration: number;
}

// ----------------------------------------------------------------------------
// Deep Research Mode
// ----------------------------------------------------------------------------

/**
 * 深度研究模式主控制器
 *
 * 协调 ResearchPlanner、ResearchExecutor、ReportGenerator 执行完整的研究流程：
 * 1. Planning: 生成研究计划
 * 2. Researching: 执行研究步骤（搜索、分析）
 * 3. Reporting: 生成最终报告
 */
export class DeepResearchMode {
  private modelRouter: ModelRouter;
  private toolExecutor: ToolExecutor;
  private onEvent: (event: AgentEvent) => void;
  private isCancelled: boolean = false;

  constructor(config: DeepResearchModeConfig) {
    this.modelRouter = config.modelRouter;
    this.toolExecutor = config.toolExecutor;
    this.onEvent = config.onEvent;
  }

  /**
   * 执行深度研究
   *
   * @param topic - 研究主题
   * @param reportStyle - 报告风格
   * @param config - 额外配置
   * @returns 研究结果
   */
  async run(
    topic: string,
    reportStyle: ReportStyle = 'default',
    config: DeepResearchConfig = {}
  ): Promise<DeepResearchResult> {
    const startTime = Date.now();
    this.isCancelled = false;

    logger.info('Starting deep research:', { topic, reportStyle });

    // 通知前端进入研究模式
    this.emitResearchStarted(topic, reportStyle);

    try {
      // 1. Planning Phase (10%)
      this.emitProgress('planning', '正在制定研究计划...', 5);

      if (this.isCancelled) {
        return this.createCancelledResult(startTime);
      }

      const planner = new ResearchPlanner(this.modelRouter);
      const planConfig: DeepResearchConfig = {
        ...config,
        reportStyle,
        enforceWebSearch: true,
      };
      // Split model strategy: use queryModel for planning
      if (config.queryModel) {
        planConfig.model = config.queryModel;
      }
      const plan = await planner.createPlan(topic, planConfig);

      this.emitProgress('planning', '研究计划已生成', 15, {
        title: `已规划 ${plan.steps.length} 个研究步骤`,
        status: 'completed',
      });

      logger.info('Research plan created:', {
        stepsCount: plan.steps.length,
        objectives: plan.objectives,
      });

      // 2. Researching Phase (15% - 75%)
      if (this.isCancelled) {
        return this.createCancelledResult(startTime);
      }

      this.emitProgress('researching', '开始执行研究...', 20);

      const executor = new ResearchExecutor(
        this.toolExecutor,
        this.modelRouter,
        (step, stepPercent) => {
          if (this.isCancelled) return;

          // 映射步骤进度到 20% - 75% 范围
          const overallPercent = 20 + (stepPercent / 100) * 55;
          this.emitProgress('researching', `执行中: ${step.title}`, overallPercent, {
            title: step.title,
            status: step.status === 'completed' ? 'completed' : 'running',
          });
        },
        {}
      );

      const executedPlan = await executor.executeWithReflection(plan, config);

      if (this.isCancelled) {
        return this.createCancelledResult(startTime);
      }

      const completedSteps = executedPlan.steps.filter(s => s.status === 'completed').length;
      const failedSteps = executedPlan.steps.filter(s => s.status === 'failed').length;

      if (executor.lastReflection) {
        logger.info('Reflection result:', {
          confidence: executor.lastReflection.confidence,
          totalBalanceScore: executor.lastReflection.totalBalanceScore,
          recommendation: executor.lastReflection.recommendation,
        });
      }

      logger.info('Research execution completed:', { completedSteps, failedSteps });

      // 3. Reporting Phase (75% - 100%)
      this.emitProgress('reporting', '正在生成研究报告...', 80);

      if (this.isCancelled) {
        return this.createCancelledResult(startTime);
      }

      // Split model strategy: use reportModel for report generation
      const reportConfig: DeepResearchConfig = { ...config };
      if (config.reportModel) {
        reportConfig.model = config.reportModel;
      }

      const generator = new ReportGenerator(this.modelRouter);
      let report = await generator.generate(executedPlan, reportStyle, reportConfig);

      // URL expansion: expand compressed URLs in the report
      const enableUrlCompression = config.enableUrlCompression !== false;
      if (enableUrlCompression && executor.urlCompressor.size > 0) {
        // 程序化兜底：将 LLM 输出中残留的裸 URL 压缩为 [srcN]
        // （Google 方案：不依赖 LLM 遵循引用格式指令）
        report.content = executor.urlCompressor.compressText(report.content);

        const expandedContent = executor.urlCompressor.expandText(report.content);
        const sourceList = executor.urlCompressor.generateSourceList();
        report = {
          ...report,
          content: expandedContent + (sourceList ? '\n\n' + sourceList : ''),
        };
        logger.info('URL compression stats:', executor.urlCompressor.getTokenSavings());
      }

      // 聚合来源（Google 模式：使用驱动去重）
      if (executor.urlCompressor.size > 0) {
        const allSources = executor.getAggregatedSources();
        // 只保留报告中实际引用了的来源
        const referencedSources = allSources.filter(s =>
          report.content.includes(s.url) ||
          report.content.includes(`[${executor.urlCompressor.compress(s.url)}]`)
        );
        report = {
          ...report,
          sources: referencedSources.length > 0 ? referencedSources : allSources,
        };
      }

      // 4. Complete
      const duration = Date.now() - startTime;

      this.emitResearchComplete(true, report, executedPlan);

      logger.info('Deep research completed:', {
        duration,
        reportLength: report.content.length,
        sourcesCount: report.sources.length,
      });

      return {
        success: true,
        report,
        plan: executedPlan,
        duration,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const duration = Date.now() - startTime;

      logger.error('Deep research failed:', errorMessage);
      this.emitResearchError(errorMessage);

      return {
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * 取消研究
   */
  cancel(): void {
    this.isCancelled = true;
    logger.info('Deep research cancelled');
  }

  // --------------------------------------------------------------------------
  // Event Emitters
  // --------------------------------------------------------------------------

  private emitResearchStarted(topic: string, reportStyle: ReportStyle): void {
    this.onEvent({
      type: 'research_mode_started',
      data: { topic, reportStyle },
    });
  }

  private emitProgress(
    phase: ResearchPhase,
    message: string,
    percent: number,
    currentStep?: { title: string; status: 'running' | 'completed' | 'failed' }
  ): void {
    const data: ResearchProgressData = {
      phase,
      message,
      percent: Math.round(percent),
      currentStep,
    };

    this.onEvent({
      type: 'research_progress',
      data,
    });
  }

  private emitResearchComplete(
    success: boolean,
    report?: ResearchReport,
    plan?: ResearchPlan
  ): void {
    this.onEvent({
      type: 'research_complete',
      data: {
        success,
        report: report
          ? {
              title: report.title,
              content: report.content,
              sources: report.sources,
            }
          : undefined,
      },
    });
  }

  private emitResearchError(error: string): void {
    this.onEvent({
      type: 'research_error',
      data: { error },
    });
  }

  private createCancelledResult(startTime: number): DeepResearchResult {
    return {
      success: false,
      error: '研究已被用户取消',
      duration: Date.now() - startTime,
    };
  }
}
