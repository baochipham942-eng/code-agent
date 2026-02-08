// ============================================================================
// Adaptive Router - Routes simple tasks to free models
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ModelMessage } from './types';
import type { ModelConfig, ModelProvider } from '../../shared/types';

const logger = createLogger('AdaptiveRouter');

export interface TaskComplexity {
  level: 'simple' | 'moderate' | 'complex';
  score: number;
  signals: string[];
}

export class AdaptiveRouter {
  private callCount = 0;
  private routingStats = { simple: 0, moderate: 0, complex: 0 };
  private freeModel: { provider: ModelProvider; model: string } = {
    provider: 'zhipu' as ModelProvider,
    model: 'glm-4.7-flash',
  };

  estimateComplexity(messages: ModelMessage[]): TaskComplexity {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return { level: 'moderate', score: 50, signals: ['no_user_message'] };

    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text || '').join(' ')
        : '';

    const signals: string[] = [];
    let score = 50; // default moderate

    const charCount = content.length;
    const codeBlocks = (content.match(/```/g) || []).length / 2;
    const hasFileRef = /\.(ts|js|py|go|rs|java|tsx|jsx|css|html|md|json|yaml|yml|toml)/i.test(content);
    const complexKeywords = ['重构', '架构', '设计', '优化', 'refactor', 'architect', 'design', 'optimize', 'migrate', '迁移'];
    const hasComplexKeyword = complexKeywords.some(kw => content.toLowerCase().includes(kw));

    // Simple indicators
    if (charCount < 50 && codeBlocks === 0 && !hasFileRef) {
      score -= 30;
      signals.push('short_message');
    }

    // Moderate indicators
    if (charCount >= 50 && charCount <= 200) {
      signals.push('medium_length');
    }
    if (codeBlocks === 1) {
      score += 10;
      signals.push('single_code_block');
    }

    // Complex indicators
    if (charCount > 200) {
      score += 20;
      signals.push('long_message');
    }
    if (codeBlocks > 1) {
      score += 20;
      signals.push('multiple_code_blocks');
    }
    if (hasComplexKeyword) {
      score += 15;
      signals.push('complex_keyword');
    }
    if (hasFileRef) {
      score += 5;
      signals.push('file_reference');
    }

    // Has images → always complex
    if (Array.isArray(lastUserMsg.content) && lastUserMsg.content.some(c => c.type === 'image')) {
      score = 80;
      signals.push('has_image');
    }

    score = Math.max(0, Math.min(100, score));
    const level = score < 30 ? 'simple' : score < 60 ? 'moderate' : 'complex';

    return { level, score, signals };
  }

  selectModel(complexity: TaskComplexity, defaultConfig: ModelConfig): ModelConfig {
    this.callCount++;
    this.routingStats[complexity.level]++;

    // Print stats every 100 calls
    if (this.callCount % 100 === 0) {
      logger.info(`[AdaptiveRouter] Stats after ${this.callCount} calls:`, this.routingStats);
    }

    // Only route simple tasks to free model
    if (complexity.level === 'simple') {
      logger.info(`[AdaptiveRouter] Simple task → ${this.freeModel.provider}/${this.freeModel.model} (score=${complexity.score}, signals=${complexity.signals.join(',')})`);
      return {
        ...defaultConfig,
        provider: this.freeModel.provider,
        model: this.freeModel.model,
      };
    }

    return defaultConfig;
  }

  recordOutcome(complexity: TaskComplexity, provider: string, success: boolean, tokens: number): void {
    logger.debug(`[AdaptiveRouter] Outcome: ${complexity.level} → ${provider}, success=${success}, tokens=${tokens}`);
  }
}

// Singleton
let instance: AdaptiveRouter | null = null;
export function getAdaptiveRouter(): AdaptiveRouter {
  if (!instance) instance = new AdaptiveRouter();
  return instance;
}
