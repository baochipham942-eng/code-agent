// ============================================================================
// Semantic Research Orchestrator - 语义研究编排器
// 整合 IntentClassifier、DataSourceRouter、AdaptiveConfig、ProgressiveLoop
// ============================================================================

import type {
  ResearchReport,
  ReportStyle,
  IntentClassification,
  AdaptiveResearchConfig,
  ProgressiveResearchState,
  EnhancedResearchProgress,
  DataSourceType,
  ResearchUserSettings,
} from './types';
import type { AgentEvent, Generation } from '../../shared/types';
import type { ModelRouter } from '../model/modelRouter';
import type { ToolExecutor } from '../tools/toolExecutor';
import { IntentClassifier } from './intentClassifier';
import { DataSourceRouter } from './dataSourceRouter';
import { AdaptiveConfigGenerator } from './adaptiveConfig';
import { ProgressiveResearchLoop } from './progressiveLoop';
import { ReportGenerator } from './reportGenerator';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SemanticResearchOrchestrator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 语义研究编排器配置
 */
export interface SemanticResearchOrchestratorConfig {
  modelRouter: ModelRouter;
  toolExecutor: ToolExecutor;
  onEvent: (event: AgentEvent) => void;
  generation?: Generation;
  userSettings?: Partial<ResearchUserSettings>;
}

/**
 * 语义研究结果
 */
export interface SemanticResearchResult {
  /** 是否成功 */
  success: boolean;
  /** 是否触发了研究模式 */
  researchTriggered: boolean;
  /** 意图分类结果 */
  classification?: IntentClassification;
  /** 研究报告（如果执行了研究） */
  report?: ResearchReport;
  /** 研究状态（如果执行了研究） */
  state?: ProgressiveResearchState;
  /** 错误信息 */
  error?: string;
  /** 持续时间（毫秒） */
  duration: number;
}

/**
 * 研究模式所需的最小 Generation（需要 web_search / web_fetch）
 */
const RESEARCH_GENERATION: Generation = {
  id: 'gen4',
  name: 'Gen 4',
  version: '4.0.0',
  description: 'Semantic Research Mode',
  tools: ['web_search', 'web_fetch'],
  systemPrompt: '',
  promptMetadata: { lineCount: 0, toolCount: 2, ruleCount: 0 },
};

// ----------------------------------------------------------------------------
// Semantic Research Orchestrator
// ----------------------------------------------------------------------------

/**
 * 语义研究编排器
 *
 * 负责：
 * 1. 分析用户查询意图
 * 2. 决定是否触发研究模式
 * 3. 配置研究参数
 * 4. 执行渐进式研究
 * 5. 生成研究报告
 */
export class SemanticResearchOrchestrator {
  private modelRouter: ModelRouter;
  private toolExecutor: ToolExecutor;
  private onEvent: (event: AgentEvent) => void;
  private generation: Generation;

  // 核心组件
  private intentClassifier: IntentClassifier;
  private dataSourceRouter: DataSourceRouter;
  private configGenerator: AdaptiveConfigGenerator;

  private isCancelled: boolean = false;

  constructor(config: SemanticResearchOrchestratorConfig) {
    this.modelRouter = config.modelRouter;
    this.toolExecutor = config.toolExecutor;
    this.onEvent = config.onEvent;
    this.generation = config.generation ?? RESEARCH_GENERATION;

    // 初始化核心组件
    this.intentClassifier = new IntentClassifier(this.modelRouter);
    this.dataSourceRouter = new DataSourceRouter({
      preferredSources: config.userSettings?.preferredSources,
      availabilityChecker: this.checkSourceAvailability.bind(this),
    });
    this.configGenerator = new AdaptiveConfigGenerator(config.userSettings);
  }

  /**
   * 分析用户查询并决定是否需要研究
   *
   * @param userMessage - 用户消息
   * @returns 意图分类结果
   */
  async analyzeIntent(userMessage: string): Promise<IntentClassification> {
    return await this.intentClassifier.classify(userMessage);
  }

  /**
   * 快速检查是否需要研究（不调用 LLM）
   */
  quickCheckResearchNeeded(userMessage: string): boolean {
    return this.intentClassifier.quickCheckResearchNeeded(userMessage);
  }

  /**
   * 执行语义驱动的研究
   *
   * @param userMessage - 用户消息
   * @param forceResearch - 强制执行研究（忽略意图判断）
   * @param reportStyle - 报告风格覆盖
   * @returns 研究结果
   */
  async run(
    userMessage: string,
    forceResearch: boolean = false,
    reportStyle?: ReportStyle
  ): Promise<SemanticResearchResult> {
    const startTime = Date.now();
    this.isCancelled = false;

    logger.info('Starting semantic research analysis:', {
      messageLength: userMessage.length,
      forceResearch,
    });

    try {
      // 1. 意图分类
      const classification = await this.analyzeIntent(userMessage);

      logger.info('Intent classification result:', {
        intent: classification.intent,
        confidence: classification.confidence,
        suggestsResearch: classification.suggestsResearch,
      });

      // 2. 判断是否触发研究
      const shouldResearch = forceResearch || (
        classification.suggestsResearch &&
        classification.confidence >= 0.6
      );

      if (!shouldResearch) {
        return {
          success: true,
          researchTriggered: false,
          classification,
          duration: Date.now() - startTime,
        };
      }

      // 3. 通知前端即将进入研究模式
      this.emitResearchDetected(classification);

      // 4. 选择数据源
      const selectedSources = await this.dataSourceRouter.selectSources(classification);

      logger.info('Selected data sources:', selectedSources);

      // 5. 生成研究配置
      const config = this.configGenerator.generateConfig(classification, selectedSources);

      // 覆盖报告风格（如果指定）
      if (reportStyle) {
        config.reportStyle = reportStyle;
      }

      logger.info('Generated research config:', {
        depth: classification.suggestedDepth,
        maxIterations: config.maxIterations,
        enabledSources: config.enabledSources,
      });

      // 6. 执行渐进式研究
      this.emitResearchStarted(userMessage, config.reportStyle);

      const researchResult = await this.executeResearch(userMessage, classification, config);

      if (this.isCancelled) {
        return {
          success: false,
          researchTriggered: true,
          classification,
          error: '研究已被用户取消',
          duration: Date.now() - startTime,
        };
      }

      // 7. 生成报告
      const report = await this.generateReport(researchResult.state, config.reportStyle);

      // 8. 完成
      this.emitResearchComplete(true, report);

      return {
        success: true,
        researchTriggered: true,
        classification,
        report,
        state: researchResult.state,
        duration: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Semantic research failed:', errorMessage);

      this.emitResearchError(errorMessage);

      return {
        success: false,
        researchTriggered: true,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 取消研究
   */
  cancel(): void {
    this.isCancelled = true;
    logger.info('Semantic research cancelled');
  }

  /**
   * 更新用户设置
   */
  updateUserSettings(settings: Partial<ResearchUserSettings>): void {
    this.configGenerator.updateUserSettings(settings);
    if (settings.preferredSources) {
      this.dataSourceRouter.setPreferredSources(settings.preferredSources);
    }
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 执行渐进式研究
   */
  private async executeResearch(
    topic: string,
    classification: IntentClassification,
    config: AdaptiveResearchConfig
  ): Promise<{ state: ProgressiveResearchState }> {
    // 从分类中提取研究目标
    const objectives = this.extractObjectives(topic, classification);

    // 创建渐进式循环
    const progressiveLoop = new ProgressiveResearchLoop(
      this.toolExecutor,
      this.modelRouter,
      {
        researchConfig: config,
        generation: this.generation,
        triggeredBy: 'semantic',
      },
      (progress) => this.handleProgress(progress)
    );

    // 执行研究
    const state = await progressiveLoop.execute(topic, objectives);

    return { state };
  }

  /**
   * 从意图分类提取研究目标
   */
  private extractObjectives(topic: string, classification: IntentClassification): string[] {
    const objectives: string[] = [];

    // 根据意图类型生成默认目标
    switch (classification.intent) {
      case 'analysis':
        objectives.push(
          `全面了解 ${topic} 的背景和现状`,
          `分析 ${topic} 的关键因素和影响`,
          `总结 ${topic} 的发展趋势和前景`
        );
        break;

      case 'comparison':
        objectives.push(
          `收集各方案/技术的核心特性`,
          `对比各方案的优劣势`,
          `提供选择建议`
        );
        break;

      case 'current_events':
        objectives.push(
          `获取最新动态和新闻`,
          `了解事件的来龙去脉`,
          `分析可能的影响和发展`
        );
        break;

      case 'technical_deep_dive':
        objectives.push(
          `理解技术原理和架构`,
          `分析关键实现细节`,
          `总结最佳实践和使用建议`
        );
        break;

      case 'multi_faceted':
        objectives.push(
          `收集各维度的信息`,
          `分析各维度之间的关联`,
          `形成综合性的结论`
        );
        break;

      default:
        objectives.push(
          `收集相关信息`,
          `分析关键点`,
          `总结结论`
        );
    }

    return objectives;
  }

  /**
   * 生成研究报告
   */
  private async generateReport(
    state: ProgressiveResearchState,
    reportStyle: ReportStyle
  ): Promise<ResearchReport> {
    // 将 ProgressiveResearchState 转换为 ReportGenerator 需要的格式
    const generator = new ReportGenerator(this.modelRouter);

    // 构建伪计划以适配现有 ReportGenerator
    const pseudoPlan = {
      topic: state.topic,
      clarifiedTopic: state.topic,
      objectives: [...state.objectivesCovered.keys()],
      steps: state.sources.map((source, i) => ({
        id: `step-${i}`,
        title: source.title,
        description: '',
        stepType: 'research' as const,
        status: 'completed' as const,
        result: source.content,
      })),
      expectedOutput: '',
      createdAt: state.startTime,
    };

    return await generator.generate(pseudoPlan, reportStyle);
  }

  /**
   * 检查数据源可用性
   */
  private async checkSourceAvailability(source: DataSourceType): Promise<boolean> {
    // TODO: 实现真实的可用性检查
    // 目前简单返回：web_search 始终可用，MCP 源需要检查连接状态
    switch (source) {
      case 'web_search':
      case 'news_search':
      case 'documentation':
        return true;

      case 'mcp_deepwiki':
      case 'mcp_github':
        // TODO: 检查 MCP 连接状态
        return false;

      case 'academic_search':
      case 'code_search':
        // 这些需要特定的工具支持
        return true;

      default:
        return false;
    }
  }

  /**
   * 处理进度回调
   */
  private handleProgress(progress: EnhancedResearchProgress): void {
    this.onEvent({
      type: 'research_progress',
      data: {
        phase: progress.phase,
        message: progress.message,
        percent: progress.percent,
        currentStep: progress.currentStep,
        // 增强信息
        triggeredBy: progress.triggeredBy,
        currentIteration: progress.currentIteration,
        maxIterations: progress.maxIterations,
        coverage: progress.coverage,
        activeSources: progress.activeSources,
        canDeepen: progress.canDeepen,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Event Emitters
  // --------------------------------------------------------------------------

  private emitResearchDetected(classification: IntentClassification): void {
    this.onEvent({
      type: 'research_detected',
      data: {
        intent: classification.intent,
        confidence: classification.confidence,
        suggestedDepth: classification.suggestedDepth,
        reasoning: classification.reasoning,
      },
    });
  }

  private emitResearchStarted(topic: string, reportStyle: ReportStyle): void {
    this.onEvent({
      type: 'research_mode_started',
      data: { topic, reportStyle, triggeredBy: 'semantic' },
    });
  }

  private emitResearchComplete(success: boolean, report?: ResearchReport): void {
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
}

// ----------------------------------------------------------------------------
// 便捷函数
// ----------------------------------------------------------------------------

/**
 * 创建语义研究编排器
 */
export function createSemanticResearchOrchestrator(
  config: SemanticResearchOrchestratorConfig
): SemanticResearchOrchestrator {
  return new SemanticResearchOrchestrator(config);
}
