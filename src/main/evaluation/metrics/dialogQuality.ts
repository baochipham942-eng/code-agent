// ============================================================================
// Dialog Quality Evaluator - 对话质量评测
// ============================================================================

import {
  EvaluationDimension,
  DIMENSION_WEIGHTS,
  type EvaluationMetric,
} from '../../../shared/types/evaluation';
import type { SessionSnapshot, DimensionEvaluator } from '../types';

/**
 * 对话质量评测器
 * 评估指标：
 * - 轮次效率
 * - 响应长度均衡性
 * - 响应相关性（关键词重叠）
 * - 响应结构化程度
 */
export class DialogQualityEvaluator implements DimensionEvaluator {
  dimension = EvaluationDimension.DIALOG_QUALITY;

  async evaluate(snapshot: SessionSnapshot): Promise<EvaluationMetric> {
    const subMetrics: { name: string; value: number; unit?: string }[] = [];
    const suggestions: string[] = [];

    const userMessages = snapshot.messages.filter((m) => m.role === 'user');
    const assistantMessages = snapshot.messages.filter((m) => m.role === 'assistant');

    // 1. 轮次效率（理想 3-7 轮）
    const turns = userMessages.length;
    let turnScore: number;
    if (turns >= 3 && turns <= 7) {
      turnScore = 100;
    } else if (turns < 3) {
      turnScore = 70;
    } else {
      turnScore = Math.max(50, 100 - (turns - 7) * 5);
    }
    subMetrics.push({ name: '轮次评分', value: turnScore, unit: '' });

    // 2. 响应长度均衡性（避免过短或过长）
    const avgAssistantLength =
      assistantMessages.length > 0
        ? assistantMessages.reduce((sum, m) => sum + m.content.length, 0) /
          assistantMessages.length
        : 0;
    let lengthScore: number;
    if (avgAssistantLength >= 100 && avgAssistantLength <= 2000) {
      lengthScore = 100;
    } else if (avgAssistantLength < 100) {
      lengthScore = 60;
      suggestions.push('响应内容偏短，可能信息不够完整');
    } else {
      lengthScore = Math.max(60, 100 - (avgAssistantLength - 2000) / 100);
      suggestions.push('响应内容较长，可以考虑更简洁');
    }
    subMetrics.push({
      name: '平均响应长度',
      value: Math.round(avgAssistantLength),
      unit: '字符',
    });

    // 3. 响应相关性（关键词重叠率）
    const relevanceScore = this.assessRelevance(snapshot);
    subMetrics.push({ name: '响应相关性', value: relevanceScore, unit: '' });

    // 4. 响应结构化程度
    const structureScore = this.assessStructure(snapshot);
    subMetrics.push({ name: '结构化程度', value: structureScore, unit: '' });

    // 计算综合分数（轮次 0.30，长度 0.25，相关性 0.25，结构化 0.20）
    const score = Math.round(
      turnScore * 0.30 + lengthScore * 0.25 + relevanceScore * 0.25 + structureScore * 0.20
    );

    return {
      dimension: this.dimension,
      score: Math.min(100, Math.max(0, score)),
      weight: DIMENSION_WEIGHTS[this.dimension] ?? 0,
      subMetrics,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  /**
   * 响应相关性：用户关键词与助手回复的重叠率
   */
  private assessRelevance(snapshot: SessionSnapshot): number {
    const userMsgs = snapshot.messages.filter((m) => m.role === 'user');
    const assistantMsgs = snapshot.messages.filter((m) => m.role === 'assistant');
    if (userMsgs.length === 0 || assistantMsgs.length === 0) return 80;

    let totalOverlap = 0;
    const pairs = Math.min(userMsgs.length, assistantMsgs.length);
    for (let i = 0; i < pairs; i++) {
      const userWords = new Set(this.extractKeywords(userMsgs[i].content));
      const assistantWords = this.extractKeywords(assistantMsgs[i].content);
      if (userWords.size === 0) continue;
      const overlap = assistantWords.filter((w) => userWords.has(w)).length;
      totalOverlap += Math.min(overlap / userWords.size, 1);
    }
    return Math.round((totalOverlap / pairs) * 100);
  }

  /**
   * 响应结构化程度（有列表、代码块、标题等）
   */
  private assessStructure(snapshot: SessionSnapshot): number {
    const assistantMsgs = snapshot.messages.filter((m) => m.role === 'assistant');
    if (assistantMsgs.length === 0) return 70;

    let structured = 0;
    for (const msg of assistantMsgs) {
      const hasLists = /[-*]\s/.test(msg.content);
      const hasCode = /```/.test(msg.content);
      const hasHeadings = /^#{1,3}\s/m.test(msg.content);
      if (hasLists || hasCode || hasHeadings) structured++;
    }
    return Math.round((structured / assistantMsgs.length) * 100);
  }

  /**
   * 提取关键词（过滤停用词和短词）
   */
  private extractKeywords(text: string): string[] {
    // 中英文分词：中文按字符，英文按空格
    const englishWords = text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // 中文关键词：提取连续中文字符（2字以上）
    const chineseMatches = text.match(/[\u4e00-\u9fff]{2,}/g) || [];

    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
      'can', 'has', 'her', 'was', 'one', 'our', 'out', 'this',
      'that', 'with', 'have', 'from', 'will', 'what', 'when',
      '的', '了', '是', '在', '我', '有', '和', '就', '不', '人',
      '都', '一', '这', '中', '大', '为', '上', '个', '到', '也',
    ]);

    return [...englishWords, ...chineseMatches].filter((w) => !stopWords.has(w));
  }
}
