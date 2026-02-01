// ============================================================================
// AI Evaluator - LLM 驱动的深度会话评测
// ============================================================================
// 使用 AI 进行语义级别的会话质量评估，替代简单的规则匹配
// ============================================================================

import { ModelRouter } from '../model/modelRouter';
import { getConfigService } from '../services';
import { createLogger } from '../services/infra/logger';
import type { EvaluationMetric } from '../../shared/types/evaluation';
import { EvaluationDimension } from '../../shared/types/evaluation';
import type { SessionSnapshot } from './types';

const logger = createLogger('AIEvaluator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface AIEvaluationResult {
  overallScore: number;
  metrics: {
    taskCompletion: { score: number; reason: string };
    responseQuality: { score: number; reason: string };
    codeQuality: { score: number; reason: string };
    efficiency: { score: number; reason: string };
    communication: { score: number; reason: string };
  };
  suggestions: string[];
  summary: string;
}

// ----------------------------------------------------------------------------
// Evaluation Prompt
// ----------------------------------------------------------------------------

const EVALUATION_PROMPT = `你是一个 AI 助手会话质量评估专家。请深度分析以下 AI 编程助手与用户的对话，给出专业评测。

评估维度（每项 0-100 分）：

1. **任务完成度** (taskCompletion)
   - 用户的核心需求是否被理解？
   - 任务是否真正完成？
   - 结果是否符合预期？

2. **响应质量** (responseQuality)
   - 回答是否准确、完整？
   - 是否有误导或错误信息？
   - 解释是否清晰易懂？

3. **代码质量** (codeQuality，如有代码)
   - 代码是否正确、可运行？
   - 是否遵循最佳实践？
   - 是否有安全隐患？
   - 无代码则给 80 分

4. **效率** (efficiency)
   - 是否快速定位问题？
   - 是否有冗余的工具调用？
   - 对话轮次是否合理？

5. **沟通能力** (communication)
   - 是否理解用户意图？
   - 是否主动澄清模糊需求？
   - 语气是否专业友好？

输出要求（JSON 格式）：
{
  "overallScore": 综合得分(0-100),
  "metrics": {
    "taskCompletion": { "score": 分数, "reason": "简短理由" },
    "responseQuality": { "score": 分数, "reason": "简短理由" },
    "codeQuality": { "score": 分数, "reason": "简短理由" },
    "efficiency": { "score": 分数, "reason": "简短理由" },
    "communication": { "score": 分数, "reason": "简短理由" }
  },
  "suggestions": ["改进建议1", "改进建议2", ...],
  "summary": "一句话总结这次对话的整体质量"
}

评分标准：
- 90-100: 优秀 (S/A)
- 70-89: 良好 (B)
- 50-69: 一般 (C)
- 0-49: 较差 (D)

请客观评价，不要过于宽松或严苛。只输出 JSON，不要其他内容。`;

// ----------------------------------------------------------------------------
// AI Evaluator Class
// ----------------------------------------------------------------------------

export class AIEvaluator {
  private modelRouter: ModelRouter;

  constructor() {
    this.modelRouter = new ModelRouter();
  }

  /**
   * 执行 AI 深度评测
   */
  async evaluate(snapshot: SessionSnapshot): Promise<AIEvaluationResult | null> {
    const conversationText = this.buildConversationText(snapshot);

    if (!conversationText) {
      logger.warn('No conversation to evaluate');
      return null;
    }

    try {
      const response = await this.callLLM(conversationText);

      if (!response) {
        logger.warn('LLM returned empty response');
        return null;
      }

      const result = this.parseResponse(response);
      logger.info('AI evaluation completed', {
        overallScore: result?.overallScore,
      });

      return result;
    } catch (error) {
      logger.error('AI evaluation failed', { error });
      return null;
    }
  }

  /**
   * 将 AI 评测结果转换为标准 EvaluationMetric 格式
   */
  convertToMetrics(result: AIEvaluationResult): EvaluationMetric[] {
    const metrics: EvaluationMetric[] = [
      {
        dimension: EvaluationDimension.TASK_COMPLETION,
        score: result.metrics.taskCompletion.score,
        weight: 0.30,
        details: { reason: result.metrics.taskCompletion.reason },
        suggestions: [],
      },
      {
        dimension: EvaluationDimension.DIALOG_QUALITY,
        score: result.metrics.responseQuality.score,
        weight: 0.20,
        details: { reason: result.metrics.responseQuality.reason },
        suggestions: [],
      },
      {
        dimension: EvaluationDimension.CODE_QUALITY,
        score: result.metrics.codeQuality.score,
        weight: 0.20,
        details: { reason: result.metrics.codeQuality.reason },
        suggestions: [],
      },
      {
        dimension: EvaluationDimension.TOOL_EFFICIENCY,
        score: result.metrics.efficiency.score,
        weight: 0.15,
        details: { reason: result.metrics.efficiency.reason },
        suggestions: [],
      },
      {
        dimension: EvaluationDimension.PERFORMANCE,
        score: result.metrics.communication.score,
        weight: 0.15,
        details: { reason: result.metrics.communication.reason },
        suggestions: [],
      },
    ];

    return metrics;
  }

  /**
   * 构建对话文本
   */
  private buildConversationText(snapshot: SessionSnapshot): string | null {
    const messages = snapshot.messages;

    if (messages.length < 2) {
      return null;
    }

    const lines: string[] = [];
    let totalChars = 0;
    const maxChars = 12000; // 限制输入长度

    // 添加工具调用统计
    if (snapshot.toolCalls.length > 0) {
      const toolStats = snapshot.toolCalls.reduce((acc, tc) => {
        acc[tc.name] = (acc[tc.name] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      lines.push(`[工具调用统计: ${JSON.stringify(toolStats)}]`);
      lines.push('');
    }

    for (const msg of messages) {
      const role = msg.role === 'user' ? '用户' : '助手';
      let content = msg.content;

      // 截断过长的消息
      if (content.length > 2000) {
        content = content.substring(0, 2000) + '...[内容过长已截断]';
      }

      const line = `【${role}】\n${content}`;

      if (totalChars + line.length > maxChars) {
        lines.push('\n...[对话过长，已截断]');
        break;
      }

      lines.push(line);
      lines.push('---');
      totalChars += line.length;
    }

    return lines.join('\n');
  }

  /**
   * 调用 LLM
   */
  private async callLLM(conversationText: string): Promise<string | null> {
    const configService = getConfigService();
    // 使用 code 模型进行评测（需要较强的分析能力）
    const codeModel = configService.getModelForCapability('code');

    const provider = codeModel?.provider || 'deepseek';
    const model = codeModel?.model || 'deepseek-chat';

    logger.debug('Calling LLM for AI evaluation', { provider, model });

    const result = await this.modelRouter.chat({
      provider: provider as 'deepseek' | 'openai' | 'claude',
      model,
      messages: [
        { role: 'system', content: EVALUATION_PROMPT },
        { role: 'user', content: `请评测以下对话：\n\n${conversationText}` },
      ],
      maxTokens: 2000,
    });

    return result.content;
  }

  /**
   * 解析 LLM 响应
   */
  private parseResponse(response: string): AIEvaluationResult | null {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No JSON found in LLM evaluation response');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as AIEvaluationResult;

      // 验证必需字段
      if (
        typeof parsed.overallScore !== 'number' ||
        !parsed.metrics ||
        !parsed.suggestions
      ) {
        logger.warn('Invalid AI evaluation response structure');
        return null;
      }

      // 确保分数在有效范围内
      parsed.overallScore = Math.max(0, Math.min(100, Math.round(parsed.overallScore)));

      for (const key of Object.keys(parsed.metrics) as (keyof typeof parsed.metrics)[]) {
        if (parsed.metrics[key]) {
          parsed.metrics[key].score = Math.max(0, Math.min(100, Math.round(parsed.metrics[key].score)));
        }
      }

      return parsed;
    } catch (error) {
      logger.error('Failed to parse AI evaluation response', {
        error,
        response: response.substring(0, 300),
      });
      return null;
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let aiEvaluatorInstance: AIEvaluator | null = null;

export function getAIEvaluator(): AIEvaluator {
  if (!aiEvaluatorInstance) {
    aiEvaluatorInstance = new AIEvaluator();
  }
  return aiEvaluatorInstance;
}
