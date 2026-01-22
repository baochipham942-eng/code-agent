// ============================================================================
// Report Generator - 研究报告生成器
// 借鉴 DeerFlow 6 种报告风格，生成结构化研究报告
// ============================================================================

import type {
  ResearchPlan,
  ResearchReport,
  ReportStyle,
} from './types';
import type { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ReportGenerator');

// ----------------------------------------------------------------------------
// Report Style Prompts
// ----------------------------------------------------------------------------

/**
 * 报告风格 Prompt 配置
 * 借鉴 DeerFlow reporter.md 的 6 种风格
 */
const REPORT_STYLE_PROMPTS: Record<ReportStyle, string> = {
  academic: `以学术论文风格撰写报告：
- 使用正式、客观的语言
- 引用来源需标注（如有）
- 包含摘要、引言、主体分析、结论等部分
- 使用专业术语
- 分析要有深度，论述要有逻辑
- 适当使用数据和事实支撑观点`,

  popular_science: `以科普文章风格撰写报告：
- 使用通俗易懂的语言
- 用类比和日常生活例子解释复杂概念
- 保持趣味性和可读性
- 适合普通读者阅读
- 可以使用比喻和故事来增强理解
- 避免过多专业术语`,

  news: `以新闻报道风格撰写报告：
- 采用倒金字塔结构（最重要的信息放在最前面）
- 开头包含核心要点（5W1H：什么、谁、何时、何地、为何、如何）
- 语言简洁有力
- 引用权威来源和具体数据
- 段落简短，便于快速阅读
- 保持客观中立的报道立场`,

  social_media: `以社交媒体风格撰写报告：
- 简短精炼，适合快速阅读
- 使用列表和要点形式
- 每个要点独立成段
- 可包含适当的 emoji 增强可读性
- 使用简单直白的语言
- 突出关键数字和结论`,

  strategic_investment: `以投资分析风格撰写报告：
- 包含市场分析、竞争格局、发展趋势
- 重视量化数据和关键指标
- 进行风险评估和机会分析
- 提供明确的投资建议或战略建议
- 分析要深入全面，不少于 3000 字
- 使用专业的商业和金融术语`,

  default: `以通用报告风格撰写：
- 结构清晰，层次分明
- 客观呈现信息和分析
- 包含摘要、正文和结论
- 适当使用小标题组织内容
- 语言简洁专业`,
};

// ----------------------------------------------------------------------------
// Report Generator
// ----------------------------------------------------------------------------

/**
 * 报告生成器
 *
 * 负责根据研究计划执行结果生成最终报告：
 * - 支持 6 种报告风格
 * - 自动提取参考来源
 * - Markdown 格式输出
 */
export class ReportGenerator {
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
  }

  /**
   * 生成研究报告
   *
   * @param plan - 执行完成的研究计划
   * @param style - 报告风格
   * @returns 生成的研究报告
   */
  async generate(
    plan: ResearchPlan,
    style: ReportStyle = 'default'
  ): Promise<ResearchReport> {
    logger.info('Generating report:', {
      topic: plan.clarifiedTopic,
      style,
      completedSteps: plan.steps.filter(s => s.status === 'completed').length,
    });

    // 收集所有步骤结果
    const stepResults = plan.steps
      .filter(s => s.status === 'completed' && s.result)
      .map(s => `## ${s.title}\n${s.result}`)
      .join('\n\n');

    if (!stepResults) {
      logger.warn('No completed steps found, generating minimal report');
      return this.createMinimalReport(plan, style);
    }

    // 生成报告
    const reportPrompt = this.buildReportPrompt(plan, stepResults, style);

    try {
      const response = await this.modelRouter.chat({
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: reportPrompt }],
        maxTokens: 4000,
      });

      const content = response.content ?? '';

      // 解析报告
      const report = this.parseReport(content, plan, style);

      logger.info('Report generated:', {
        title: report.title,
        contentLength: report.content.length,
        sourcesCount: report.sources.length,
      });

      return report;
    } catch (error: unknown) {
      logger.error('Failed to generate report:', error);
      return this.createMinimalReport(plan, style);
    }
  }

  /**
   * 构建报告生成 Prompt
   */
  private buildReportPrompt(
    plan: ResearchPlan,
    stepResults: string,
    style: ReportStyle
  ): string {
    return `请基于以下研究内容，生成一份完整的研究报告。

## 研究主题
${plan.clarifiedTopic}

## 研究目标
${plan.objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}

## 研究结果
${stepResults}

## 写作风格要求
${REPORT_STYLE_PROMPTS[style]}

## 输出格式要求

请输出 Markdown 格式的报告，包含以下部分：
1. **标题**（使用 # 一级标题）
2. **摘要**（100-200 字，概述主要发现）
3. **正文**（根据风格要求组织，使用小标题分节）
4. **结论**（总结关键发现和建议）
5. **参考来源**（如果研究内容中有引用的链接，请整理为参考来源列表）

请直接输出报告内容，不要添加额外的说明文字：`;
  }

  /**
   * 解析报告内容
   */
  private parseReport(
    content: string,
    plan: ResearchPlan,
    style: ReportStyle
  ): ResearchReport {
    // 提取标题
    const titleMatch = content.match(/^#\s+(.+?)(?:\n|$)/m);
    const title = titleMatch?.[1]?.trim() ?? plan.clarifiedTopic;

    // 提取摘要
    const summaryMatch = content.match(/##\s*摘要\s*\n([\s\S]*?)(?=\n##|$)/i);
    const summary = summaryMatch?.[1]?.trim() ?? this.extractFirstParagraph(content);

    // 提取来源
    const sources = this.extractSources(content);

    // 从研究步骤结果中也提取来源
    const stepSources = plan.steps
      .filter(s => s.result)
      .flatMap(s => this.extractSources(s.result ?? ''));

    // 合并去重
    const allSources = this.deduplicateSources([...sources, ...stepSources]);

    return {
      title,
      style,
      summary,
      content,
      sources: allSources,
      generatedAt: Date.now(),
    };
  }

  /**
   * 提取第一段作为摘要
   */
  private extractFirstParagraph(content: string): string {
    // 跳过标题，找第一个非空段落
    const lines = content.split('\n');
    let paragraph = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        paragraph += trimmed + ' ';
        if (paragraph.length > 200) break;
      } else if (paragraph) {
        break;
      }
    }

    return paragraph.trim().slice(0, 200);
  }

  /**
   * 从内容中提取来源链接
   */
  private extractSources(
    content: string
  ): Array<{ title: string; url: string; snippet?: string }> {
    const sources: Array<{ title: string; url: string; snippet?: string }> = [];

    // 匹配 Markdown 链接格式 [title](url)
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    let match;
    while ((match = markdownLinkPattern.exec(content)) !== null) {
      sources.push({
        title: match[1],
        url: match[2],
      });
    }

    // 匹配纯 URL
    const urlPattern = /(?<!\()(https?:\/\/[^\s\)\]\>\"\']+)/g;
    while ((match = urlPattern.exec(content)) !== null) {
      const url = match[1];
      // 检查是否已在 sources 中
      if (!sources.some(s => s.url === url)) {
        sources.push({
          title: this.extractDomainFromUrl(url),
          url,
        });
      }
    }

    return sources;
  }

  /**
   * 从 URL 提取域名作为标题
   */
  private extractDomainFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace('www.', '');
    } catch {
      return url;
    }
  }

  /**
   * 去重来源
   */
  private deduplicateSources(
    sources: Array<{ title: string; url: string; snippet?: string }>
  ): Array<{ title: string; url: string; snippet?: string }> {
    const seen = new Set<string>();
    return sources.filter(source => {
      if (seen.has(source.url)) {
        return false;
      }
      seen.add(source.url);
      return true;
    });
  }

  /**
   * 创建最小可用报告
   */
  private createMinimalReport(
    plan: ResearchPlan,
    style: ReportStyle
  ): ResearchReport {
    const failedSteps = plan.steps.filter(s => s.status === 'failed');
    const errorMessages = failedSteps.map(s => `- ${s.title}: ${s.error}`).join('\n');

    const content = `# ${plan.clarifiedTopic}

## 摘要

由于研究过程中遇到问题，本报告内容有限。请检查网络连接后重试。

## 研究目标

${plan.objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}

## 执行情况

研究计划包含 ${plan.steps.length} 个步骤：
- 完成: ${plan.steps.filter(s => s.status === 'completed').length}
- 失败: ${failedSteps.length}
- 待执行: ${plan.steps.filter(s => s.status === 'pending').length}

${errorMessages ? `### 错误信息\n${errorMessages}` : ''}

## 结论

研究未能完成，建议检查网络连接后重新尝试，或修改研究主题后重试。
`;

    return {
      title: plan.clarifiedTopic,
      style,
      summary: '研究未能完成，请检查网络连接后重试。',
      content,
      sources: [],
      generatedAt: Date.now(),
    };
  }
}
