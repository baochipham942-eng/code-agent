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
import { createProductionJevCall, isJevFeatureOn } from './jevFeatures';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import {
  JEV_ROUTER_LEVEL_SCORES,
  JEV_ROUTER_QUESTIONS,
  JEV_ROUTER_THRESHOLDS,
  matchesJevRouterHighRisk,
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

export function withClarificationHint<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  // Claude 系 provider 只取第一条 system 消息——追加在末尾会被静默丢弃
  // （ai-review R1），所以能合并就并进首条 system；没有或内容非纯文本才追加。
  // 泛型签名：loopTypes 与 model/types 两个 ModelMessage 都能用（ai-review R7 上移消费点）。
  const first = messages[0];
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${JEV_CLARIFICATION_HINT}` }, ...messages.slice(1)];
  }
  return [...messages, { role: 'system', content: JEV_CLARIFICATION_HINT } as T];
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
   * Optional Jev router for the automatic tier.
   *
   * 消费边界：AdaptiveRouter 只喂模型路由——自动档选模型的消费方是 modelDecision.ts
   * （runEngineInference / modelRouter 的 complexityOverride）；taskComplexityAnalyzer
   * （src/host/planning/）喂的是规划与提示（conversationRuntime.ts / autoPlanner.ts）。
   * 两者不写进同一条 telemetry、互不消费；本函数不改 taskComplexityAnalyzer 一侧。
   *
   * A low-confidence answer never downgrades the requested tier; any provider failure
   * returns the heuristic. 开关默认开（CODE_AGENT_JEV_ROUTER=0/'false' 关，单源
   * jevFeatures）；无 key 时逐调用静默降级为与开关关逐字段一致（不经规则地板）。
   * 规则地板独立于判官：开关开时，最后一条用户消息命中
   * JEV_ROUTER_HIGH_RISK_PATTERNS（删除/付款转账/对外发帖发送/凭据变更/不可逆覆盖，
   * 中英文）则无论 Jev 答什么、无论是否回落启发式，结果都不得为 simple；开关关时
   * 整段不生效（与启发式逐字段一致，零行为变化）。
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
    if (!isJevFeatureOn('router')) return this.estimateComplexity(messages);
    const lastUserMsg = [...messages].reverse().find((message) => message.role === 'user');
    const content = lastUserMsg
      ? typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.filter((part) => part.type === 'text').map((part) => part.text || '').join(' ')
          : ''
      : '';
    // 规则地板在判官之前计算，命中后对 Jev 路径与启发式回落路径同样生效。
    const ruleFloorHit = content.length > 0 && matchesJevRouterHighRisk(content);
    const applyRuleFloor = (result: TaskComplexity): TaskComplexity => {
      if (!ruleFloorHit || result.level !== 'simple') return result;
      return {
        ...result,
        level: 'moderate',
        score: Math.max(result.score, JEV_ROUTER_LEVEL_SCORES.moderate),
        signals: [...result.signals, 'high_risk_rule_floor'],
      };
    };
    const fallback = (reason: string) => {
      logger.warn(`[AdaptiveRouter] Jev fallback: ${reason}`);
      return applyRuleFloor(this.estimateComplexity(messages));
    };
    if (!lastUserMsg) return fallback('no_user_message');
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
    const call = systemOne ?? createProductionJevCall('router');
    let answers: JevAnswers;
    try {
      answers = await call(state, JEV_ROUTER_QUESTIONS, { signal });
    } catch (error) {
      // 取消不是故障：静默回启发式，不打 warn、不记 provider_error（ai-review R7 Nit）。
      if (signal?.aborted) return applyRuleFloor(this.estimateComplexity(messages));
      // 无 key 静默降级（N-JEV-DEFAULT-ON）：默认开后无 key 是常态而非故障，
      // 不逐调用打 warn（计数与单次留痕在 jevFeatures），且降级结果与开关关
      // 逐字段一致——不经规则地板，保证快照字节不变。
      if ((error as { code?: string } | null | undefined)?.code === 'TYPESAFE_KEY_MISSING') {
        return this.estimateComplexity(messages);
      }
      return fallback(`provider_error: ${error instanceof Error ? error.message : String(error)}`);
    }
    const intent = answerChoice(answers, 'intent');
    const complexity = answerChoice(answers, 'complexity');
    const needsClarification = answerNoul(answers, 'needs_clarification');
    const needsVision = answerNoul(answers, 'needs_vision');
    const highStakes = answerNoul(answers, 'high_stakes');
    if (!intent || !complexity || needsClarification === null || needsVision === null || highStakes === null) {
      return fallback('malformed_answers');
    }
    // intent 必须是问句 criteria 里的枚举值，任意字符串不进 signals（ai-review R7 Nit）。
    if (!Object.keys(JEV_ROUTER_QUESTIONS.intent.criteria ?? {}).includes(intent.choice)) {
      return fallback('unknown_intent_choice');
    }
    // complexity 是命名键（simple/moderate/complex），不再收 0-3 整数；
    // 校准 confidence 低于下限回落启发式，不阻塞开聊。
    const level = complexity.choice as keyof typeof JEV_ROUTER_LEVEL_SCORES;
    if (!Object.keys(JEV_ROUTER_QUESTIONS.complexity.criteria ?? {}).includes(complexity.choice)
      || complexity.confidence < JEV_ROUTER_THRESHOLDS.minComplexityConfidence) {
      return fallback('low_confidence_or_invalid_complexity');
    }
    const signals = [
      `jev_intent:${intent.choice}`,
      `jev_confidence:${complexity.confidence.toFixed(2)}`,
      `needs_clarification:${needsClarification.toFixed(2)}`,
      `needs_vision:${needsVision.toFixed(2)}`,
      `high_stakes:${highStakes.toFixed(2)}`,
    ];
    if (state.has_image === true) signals.push('has_image');
    // Clarification、vision、high-stakes、规则地板都是安全信号，只升不降——
    // 命中任一即不得为 simple（不降到 quick/free 档）。副作用仍由调用方控制。
    const suggestClarification = needsClarification >= JEV_ROUTER_THRESHOLDS.needsClarification;
    const neverSimple = state.has_image === true || suggestClarification
      || needsVision >= JEV_ROUTER_THRESHOLDS.needsVision
      || highStakes >= JEV_ROUTER_THRESHOLDS.highStakes;
    const safeLevel: TaskComplexity['level'] = neverSimple && level === 'simple' ? 'moderate' : level;
    const result: TaskComplexity = applyRuleFloor({
      level: safeLevel,
      score: JEV_ROUTER_LEVEL_SCORES[safeLevel],
      signals,
      ...(suggestClarification ? { suggestClarification } : {}),
    });
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
