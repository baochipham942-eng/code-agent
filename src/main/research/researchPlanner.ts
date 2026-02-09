// ============================================================================
// Research Planner - 研究计划生成器
// 借鉴 DeerFlow 8 维分析框架，生成结构化研究计划
// ============================================================================

import type {
  ResearchPlan,
  ResearchStep,
  ReportStyle,
  DeepResearchConfig,
} from './types';
import type { ModelRouter } from '../model/modelRouter';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ResearchPlanner');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * 计划生成 Prompt
 * 借鉴 DeerFlow planner.md 的 8 维分析框架
 */
const PLAN_PROMPT_TEMPLATE = `你是一个专业的研究规划师。请为以下主题制定详细的研究计划。

## 研究主题
{{TOPIC}}

## 分析框架

请从以下 8 个维度思考研究方向（根据主题选择相关维度）：

1. **历史维度**: 这个主题的起源和发展历程
2. **现状维度**: 当前的状态、趋势和关键数据
3. **未来维度**: 发展方向、预测和潜在变化
4. **利益方维度**: 涉及的各方及其立场和利益
5. **量化维度**: 可量化的数据、统计和指标
6. **定性维度**: 观点、评价和主观分析
7. **对比维度**: 与相关主题的比较和差异
8. **风险维度**: 潜在风险、挑战和不确定性

## 步骤类型说明

每个步骤必须指定 stepType：
- **research**: 需要网络搜索收集信息的步骤（必须提供 searchQueries）
- **analysis**: 基于已收集信息进行纯分析推理的步骤
- **processing**: 需要执行代码或处理数据的步骤（当前会转为分析）

## 要求

1. 至少包含一个 research 类型步骤（用于网络搜索）
2. 步骤数量控制在 {{MAX_STEPS}} 个以内
3. 步骤之间应有逻辑递进关系
4. 每个 research 步骤需提供 2-3 个搜索关键词
5. 使用中文规划，搜索关键词可以是中英文

## 输出格式

请严格以 JSON 格式输出（不要添加任何其他文字）：

\`\`\`json
{
  "clarifiedTopic": "更精确的研究主题描述",
  "objectives": ["研究目标1", "研究目标2", "研究目标3"],
  "steps": [
    {
      "id": "step_1",
      "title": "搜集XXX信息",
      "description": "通过网络搜索收集关于XXX的最新信息",
      "stepType": "research",
      "needSearch": true,
      "searchQueries": ["搜索词1", "搜索词2"]
    },
    {
      "id": "step_2",
      "title": "分析XXX",
      "description": "基于收集的信息分析...",
      "stepType": "analysis"
    }
  ],
  "expectedOutput": "预期产出的报告类型和内容描述"
}
\`\`\``;

// ----------------------------------------------------------------------------
// Research Planner
// ----------------------------------------------------------------------------

/**
 * 研究计划器
 *
 * 负责生成结构化的研究计划，包括：
 * - 主题澄清
 * - 研究目标制定
 * - 步骤规划（research/analysis/processing）
 * - 计划验证和修复
 */
export class ResearchPlanner {
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
  }

  /**
   * 生成研究计划
   *
   * @param topic - 用户输入的研究主题
   * @param config - 研究配置
   * @returns 结构化的研究计划
   */
  async createPlan(
    topic: string,
    config: DeepResearchConfig = {}
  ): Promise<ResearchPlan> {
    logger.info('Creating research plan for topic:', topic);

    const planPrompt = this.buildPlanPrompt(topic, config);

    try {
      const response = await this.modelRouter.chat({
        provider: (config.modelProvider as 'deepseek' | 'openai' | 'claude' | 'openrouter') ?? DEFAULT_PROVIDER,
        model: config.model ?? DEFAULT_MODEL,
        messages: [{ role: 'user', content: planPrompt }],
        maxTokens: 2000,
      });

      // 解析 JSON 响应
      const planJson = this.parseJsonResponse(response.content ?? '');

      // 验证和修复计划
      const validatedPlan = this.validateAndFixPlan(planJson, topic, config);

      logger.info('Research plan created:', {
        topic: validatedPlan.clarifiedTopic,
        stepsCount: validatedPlan.steps.length,
        hasResearchStep: validatedPlan.steps.some(s => s.stepType === 'research'),
      });

      return validatedPlan;
    } catch (error) {
      logger.error('Failed to create research plan:', error);
      // 返回一个最小可用的计划
      return this.createFallbackPlan(topic, config);
    }
  }

  /**
   * 构建计划 Prompt
   */
  private buildPlanPrompt(topic: string, config: DeepResearchConfig): string {
    return PLAN_PROMPT_TEMPLATE
      .replace('{{TOPIC}}', topic)
      .replace('{{MAX_STEPS}}', String(config.maxSteps ?? 5));
  }

  /**
   * 解析 JSON 响应
   * 处理各种可能的格式问题
   */
  private parseJsonResponse(content: string): Partial<ResearchPlan> {
    // 尝试提取 JSON 代码块
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // 尝试修复常见的 JSON 问题
      try {
        // 移除可能的尾部逗号
        const fixedJson = jsonStr
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']');
        return JSON.parse(fixedJson);
      } catch {
        logger.warn('Failed to parse plan JSON, using fallback');
        return {};
      }
    }
  }

  /**
   * 验证和修复计划
   * 借鉴 DeerFlow validate_and_fix_plan 逻辑
   */
  private validateAndFixPlan(
    plan: Partial<ResearchPlan>,
    originalTopic: string,
    config: DeepResearchConfig
  ): ResearchPlan {
    const steps = (plan.steps ?? []).map((step, index) => {
      const fixedStep: ResearchStep = {
        id: step.id ?? `step_${index + 1}`,
        title: step.title ?? `步骤 ${index + 1}`,
        description: step.description ?? '',
        stepType: step.stepType ?? 'analysis',
        status: 'pending',
      };

      // 确保 research 类型有搜索关键词
      if (fixedStep.stepType === 'research') {
        fixedStep.needSearch = true;
        fixedStep.searchQueries = step.searchQueries?.length
          ? step.searchQueries
          : [plan.clarifiedTopic ?? originalTopic];
      }

      // 根据内容推断类型
      if (!step.stepType) {
        if (step.needSearch || step.searchQueries?.length) {
          fixedStep.stepType = 'research';
          fixedStep.needSearch = true;
        } else if (
          step.title?.includes('分析') ||
          step.title?.includes('总结') ||
          step.title?.includes('对比')
        ) {
          fixedStep.stepType = 'analysis';
        }
      }

      return fixedStep;
    });

    // 强制网络搜索：确保至少有一个 research 步骤
    if (config.enforceWebSearch !== false) {
      const hasResearch = steps.some(s => s.stepType === 'research' && s.needSearch);
      if (!hasResearch && steps.length > 0) {
        // 将第一个步骤改为 research
        steps[0].stepType = 'research';
        steps[0].needSearch = true;
        steps[0].searchQueries = steps[0].searchQueries ?? [
          plan.clarifiedTopic ?? originalTopic,
        ];
      } else if (steps.length === 0) {
        // 创建一个默认的 research 步骤
        steps.push({
          id: 'step_1',
          title: '搜集背景信息',
          description: `通过网络搜索收集关于"${originalTopic}"的最新信息和背景资料`,
          stepType: 'research',
          needSearch: true,
          searchQueries: [originalTopic],
          status: 'pending',
        });
      }
    }

    // 确保有分析步骤
    const hasAnalysis = steps.some(s => s.stepType === 'analysis');
    if (!hasAnalysis) {
      steps.push({
        id: `step_${steps.length + 1}`,
        title: '综合分析',
        description: '基于收集的信息进行综合分析和总结',
        stepType: 'analysis',
        status: 'pending',
      });
    }

    return {
      topic: originalTopic,
      clarifiedTopic: plan.clarifiedTopic ?? originalTopic,
      objectives: plan.objectives ?? ['收集相关信息', '分析关键问题', '形成研究结论'],
      steps,
      expectedOutput: plan.expectedOutput ?? '结构化研究报告',
      createdAt: Date.now(),
    };
  }

  /**
   * 创建最小可用的回退计划
   */
  private createFallbackPlan(topic: string, config: DeepResearchConfig): ResearchPlan {
    logger.info('Creating fallback plan for topic:', topic);

    return {
      topic,
      clarifiedTopic: topic,
      objectives: [
        '收集主题相关的最新信息',
        '分析关键要点和趋势',
        '总结形成研究结论',
      ],
      steps: [
        {
          id: 'step_1',
          title: '信息搜集',
          description: `搜索收集关于"${topic}"的最新信息、新闻和研究资料`,
          stepType: 'research',
          needSearch: true,
          searchQueries: [
            topic,
            `${topic} 最新进展`,
            `${topic} 分析报告`,
          ],
          status: 'pending',
        },
        {
          id: 'step_2',
          title: '深度分析',
          description: '基于收集的信息，分析关键要点、趋势和影响因素',
          stepType: 'analysis',
          status: 'pending',
        },
        {
          id: 'step_3',
          title: '总结结论',
          description: '综合所有分析结果，形成研究结论和建议',
          stepType: 'analysis',
          status: 'pending',
        },
      ],
      expectedOutput: config.reportStyle
        ? `${config.reportStyle} 风格的研究报告`
        : '结构化研究报告',
      createdAt: Date.now(),
    };
  }
}
