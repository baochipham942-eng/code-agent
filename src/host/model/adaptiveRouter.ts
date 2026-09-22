// ============================================================================
// Adaptive Router - Routes simple tasks to free models
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ModelMessage } from './types';
import type { ModelConfig, ModelProvider } from '../../shared/contract';
import {
  DEFAULT_MODELS,
  MODEL_MAX_TOKENS,
  getContextWindow,
  PROVIDER_REGISTRY,
} from '../../shared/constants';
import { resolveBaseFallbackChain } from './modelRouterPolicy';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import {
  JEV_ROUTER_QUESTIONS,
  JEV_ROUTER_THRESHOLDS,
  type JevAnswers,
  type JevSystemOneCall,
} from '../../shared/constants/jevQuestions';

const logger = createLogger('AdaptiveRouter');

export interface TaskComplexity {
  level: 'simple' | 'moderate' | 'complex';
  score: number;
  signals: string[];
  /**
   * Jev needs_clarification ≥ 阈值时置真：请求缺关键信息，调用方应让用户先澄清
   * （如给主模型附带澄清提示），而不是闷头猜。启发式路径永不设置。
   */
  suggestClarification?: boolean;
}

/**
 * 澄清提示：suggestClarification 轮发给主模型的附加 system 消息（消费方 modelRouter）。
 * 只影响当次 provider 调用，不写回会话历史。
 */
const JEV_CLARIFICATION_HINT =
  'The user\'s request may be missing information needed to proceed. If anything essential is ambiguous, ask one concise clarifying question first instead of guessing; otherwise proceed normally.';

export function withClarificationHint(messages: ModelMessage[]): ModelMessage[] {
  return [...messages, { role: 'system', content: JEV_CLARIFICATION_HINT }];
}

function answerNoul(answers: JevAnswers, key: string): number | null {
  const answer = answers[key];
  if (!answer || typeof answer !== 'object' || !('noul' in answer)) return null;
  const value = answer.noul;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function answerChoice(answers: JevAnswers, key: string): { choice: string; confidence: number } | null {
  const answer = answers[key];
  if (!answer || typeof answer !== 'object' || !('choice' in answer)) return null;
  const choice = answer.choice;
  const confidence = answer.confidence;
  return typeof choice === 'string' && typeof confidence === 'number'
    && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? { choice, confidence }
    : null;
}

export interface FallbackContext {
  reason: 'context_overflow' | 'rate_limit' | 'unavailable' | 'auth' | 'network';
  currentModel: string;
  currentProvider: string;
  taskCapabilities?: string[];
  budgetRemaining?: number;
}

export interface FallbackResult {
  provider: string;
  model: string;
  contextWindow: number;
  reason: string;
}

export class AdaptiveRouter {
  private callCount = 0;
  private routingStats = { simple: 0, moderate: 0, complex: 0 };
  private freeModelDisabled = false; // 持久性错误（401/403）后禁用
  private freeModel: { provider: ModelProvider; model: string } = {
    provider: 'zhipu' as ModelProvider,
    model: DEFAULT_MODELS.quick,
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

  /**
   * Optional Jev router for the automatic tier. A low-confidence answer never
   * downgrades the requested tier; any provider failure returns the heuristic.
   *
   * Per-turn dedup: the agent loop re-runs inference() on every iteration with the
   * same last user message, so the Jev estimate is cached on (content, has_image)
   * with a short TTL. Only successful Jev estimates are cached; any doubt fails
   * open to a fresh Jev call (which itself fails back to the heuristic).
   */
  private static readonly JEV_CACHE_TTL_MS = 120_000;
  private static readonly JEV_CACHE_MAX_ENTRIES = 32;
  private jevEstimateCache = new Map<string, { value: TaskComplexity; expiresAt: number }>();

  async estimateComplexityWithJev(
    messages: ModelMessage[],
    systemOne?: JevSystemOneCall,
    signal?: AbortSignal,
  ): Promise<TaskComplexity> {
    const fallback = (reason: string) => {
      logger.warn(`[AdaptiveRouter] Jev fallback: ${reason}`);
      return this.estimateComplexity(messages);
    };
    if (process.env.CODE_AGENT_JEV_ROUTER !== '1') return this.estimateComplexity(messages);
    const lastUserMsg = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUserMsg) return fallback('no_user_message');
    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.filter((part) => part.type === 'text').map((part) => part.text || '').join(' ')
        : '';
    const hasImage = Array.isArray(lastUserMsg.content) && lastUserMsg.content.some((part) => part.type === 'image');
    const cacheKey = `${hasImage ? 'img' : 'txt'}:${content.slice(0, 12_000)}`;
    const cached = this.jevEstimateCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return { ...cached.value, signals: [...cached.value.signals] };
      }
      this.jevEstimateCache.delete(cacheKey);
    }
    const state = {
      request: guardSensitiveText(content.slice(0, 12_000), { surface: 'telemetry', mode: 'model-context' }),
      has_image: hasImage,
      message_count: messages.length,
    };
    const call = systemOne ?? (async (stateArg, questions, options) => {
      const { systemOne: productionSystemOne } = await import('./providers/typesafeProvider');
      return productionSystemOne(stateArg, questions, options);
    });
    let answers: JevAnswers;
    try {
      answers = await call(state, JEV_ROUTER_QUESTIONS, { signal });
    } catch {
      return fallback('provider_error');
    }
    const intent = answerChoice(answers, 'intent');
    const complexity = answerChoice(answers, 'complexity');
    const needsClarification = answerNoul(answers, 'needs_clarification');
    const destructiveIntent = answerNoul(answers, 'destructive_intent');
    if (!intent || !complexity || needsClarification === null || destructiveIntent === null) {
      return fallback('malformed_answers');
    }
    const numericLevel = Number(complexity.choice);
    if (!Number.isInteger(numericLevel) || numericLevel < 0 || numericLevel > 3 || complexity.confidence < JEV_ROUTER_THRESHOLDS.minComplexityConfidence) {
      return fallback('low_confidence_or_invalid_complexity');
    }
    const signals = [
      `jev_intent:${intent.choice}`,
      `jev_confidence:${complexity.confidence.toFixed(2)}`,
      `needs_clarification:${needsClarification.toFixed(2)}`,
      `destructive_intent:${destructiveIntent.toFixed(2)}`,
    ];
    if (state.has_image === true) signals.push('has_image');
    // Clarification and destructive intent are safety signals, never a reason to
    // route down to the free model. The caller still keeps control of side effects.
    const suggestClarification = needsClarification >= JEV_ROUTER_THRESHOLDS.needsClarification;
    const safeLevel = state.has_image === true || suggestClarification || destructiveIntent >= JEV_ROUTER_THRESHOLDS.destructiveIntent
      ? Math.max(2, numericLevel)
      : numericLevel;
    const safeScore = safeLevel * (100 / 3);
    const result: TaskComplexity = {
      level: safeScore < 30 ? 'simple' : safeScore < 60 ? 'moderate' : 'complex',
      score: Math.round(safeScore),
      signals,
      ...(suggestClarification ? { suggestClarification } : {}),
    };
    if (this.jevEstimateCache.size >= AdaptiveRouter.JEV_CACHE_MAX_ENTRIES) {
      const oldest = this.jevEstimateCache.keys().next();
      if (!oldest.done) this.jevEstimateCache.delete(oldest.value);
    }
    this.jevEstimateCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + AdaptiveRouter.JEV_CACHE_TTL_MS,
    });
    return { ...result, signals: [...result.signals] };
  }

  selectModel(complexity: TaskComplexity, defaultConfig: ModelConfig): ModelConfig {
    this.callCount++;
    this.routingStats[complexity.level]++;

    // Print stats every 100 calls
    if (this.callCount % 100 === 0) {
      logger.info(`[AdaptiveRouter] Stats after ${this.callCount} calls:`, this.routingStats);
    }

    // 环境变量禁用自适应路由（评测等场景需统一模型）。
    // 注意：webServer 也会设 CODE_AGENT_CLI_MODE=true（keytar 守卫），但桌面/web 聊天
    // 是用户选"自动"的主场景，必须用 CODE_AGENT_WEB_MODE 区分，只禁纯 CLI/评测。
    const isCliOnly = process.env.CODE_AGENT_CLI_MODE === 'true'
      && process.env.CODE_AGENT_WEB_MODE !== 'true';
    if (process.env.ADAPTIVE_ROUTER_DISABLED === 'true' || isCliOnly) {
      return defaultConfig;
    }

    // Only route simple tasks to free model (skip if disabled due to auth failure)
    if (complexity.level === 'simple' && !this.freeModelDisabled) {
      logger.info(`[AdaptiveRouter] Simple task → ${this.freeModel.provider}/${this.freeModel.model} (score=${complexity.score}, signals=${complexity.signals.join(',')})`);
      return {
        ...defaultConfig,
        provider: this.freeModel.provider,
        model: this.freeModel.model,
      };
    }

    // 复杂任务主动提高 maxTokens，避免输出截断
    if (complexity.level === 'complex' && defaultConfig.maxTokens && defaultConfig.maxTokens < MODEL_MAX_TOKENS.EXTENDED) {
      logger.info(`[AdaptiveRouter] Complex task: boosting maxTokens ${defaultConfig.maxTokens} → ${MODEL_MAX_TOKENS.EXTENDED}`);
      return { ...defaultConfig, maxTokens: MODEL_MAX_TOKENS.EXTENDED };
    }

    return defaultConfig;
  }

  /**
   * 持久性错误（401/403）后禁用 free model 路由，避免重复失败
   */
  disableFreeModel(reason: string): void {
    if (!this.freeModelDisabled) {
      this.freeModelDisabled = true;
      logger.info(`[AdaptiveRouter] Free model disabled: ${reason}`);
    }
  }

  selectFallback(context: FallbackContext): FallbackResult | null {
    switch (context.reason) {
      case 'context_overflow':
        return this.findLargerContextModel(context);
      case 'rate_limit':
        return this.findAlternateProvider(context);
      case 'unavailable':
      case 'network':
        return this.walkFallbackChain(context);
      case 'auth':
        return null; // can't recover by switching
    }
  }

  private findLargerContextModel(context: FallbackContext): FallbackResult | null {
    const currentWindow = getContextWindow(context.currentModel);
    const chain = resolveBaseFallbackChain(context.currentProvider);
    for (const { provider, model } of chain) {
      if (provider === context.currentProvider) continue;
      const window = getContextWindow(model);
      if (window > currentWindow) {
        return {
          provider,
          model,
          contextWindow: window,
          reason: `larger context: ${window} > ${currentWindow}`,
        };
      }
    }
    // Also check providers not in the current chain
    for (const [provider, info] of Object.entries(PROVIDER_REGISTRY)) {
      if (provider === context.currentProvider) continue;
      if (chain.some(c => c.provider === provider)) continue;
      const model = info.defaultModel;
      const window = getContextWindow(model);
      if (window > currentWindow) {
        return {
          provider,
          model,
          contextWindow: window,
          reason: `larger context: ${window} > ${currentWindow}`,
        };
      }
    }
    return null;
  }

  private findAlternateProvider(context: FallbackContext): FallbackResult | null {
    const chain = resolveBaseFallbackChain(context.currentProvider);
    for (const { provider, model } of chain) {
      if (provider === context.currentProvider) continue;
      return {
        provider,
        model,
        contextWindow: getContextWindow(model),
        reason: `alternate provider for ${context.reason}`,
      };
    }
    return null;
  }

  private walkFallbackChain(context: FallbackContext): FallbackResult | null {
    return this.findAlternateProvider(context);
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
