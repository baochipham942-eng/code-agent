// ============================================================================
// Model Decision - 单一路由决策入口（ADR-019）
//
// 所有模型路由决策（主聊天 adaptive / subagent 角色分层）的唯一出口。
// 输出结构化决策对象，UI trace / 日志 / 成本统计统一消费这个对象，
// 消除"两条引擎、两种行为"和 adaptive 标志泄漏问题。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ModelConfig, ModelProvider } from '../../shared/contract';
import type {
  ModelProviderSettings,
  TaskModelStrategySettings,
  TaskStrategyProfileId,
  TaskStrategyRuleIntent,
  TaskStrategyRuleSettings,
} from '../../shared/contract/settings';
import type {
  BillingMode,
  ModelCapabilityNeed,
  ModelCostPolicy,
  ModelDecision,
  ModelDecisionReason,
  ModelProviderHealthSnapshot,
  ModelProviderIdentity,
  ModelSpeedPolicy,
  ModelTaskClass,
  ModelToolPolicy,
} from '../../shared/contract/modelDecision';
import type { ModelMessage } from './types';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../shared/constants';
import {
  formatProviderProtocolLabel,
  isDynamicCustomProviderId,
  resolveProviderProtocol,
} from '../../shared/modelRuntime';
import { getAdaptiveRouter, type TaskComplexity } from './adaptiveRouter';
import { getProviderHealthMonitor } from './providerHealthMonitor';

const logger = createLogger('ModelDecision');

export type { BillingMode, ModelDecision, ModelDecisionReason } from '../../shared/contract/modelDecision';
export type ModelDecisionProviderSettings = Pick<ModelProviderSettings, 'enabled' | 'billingMode' | 'displayName' | 'baseUrl' | 'protocol'>;

export interface ModelDecisionInput {
  /** 请求的模型配置（会话默认或 override） */
  requestedConfig: ModelConfig;
  /** 用于复杂度/能力判断的消息 */
  messages: ModelMessage[];
  /** 调用路径：主聊天 or subagent */
  context: 'main-chat' | 'subagent';
  /** subagent 角色（context='subagent' 时提供） */
  subagentRole?: string;
  /** 默认模型所属 provider 的计费方式（批 2 接 settings；缺省 payg 保持现有行为） */
  billingMode?: BillingMode;
  /** provider 身份配置切片，用于会话页解释来源、协议和 endpoint */
  providerSettings?: Record<string, ModelDecisionProviderSettings>;
  /** 全局任务策略。传入后，main-chat adaptive 会按策略 profile 路由。 */
  taskStrategy?: TaskModelStrategySettings;
}

export interface ModelDecisionResult {
  /** 实际应使用的模型配置 */
  config: ModelConfig;
  /** 结构化决策（供 UI/日志/统计消费） */
  decision: ModelDecision;
}

/** adaptive 简单任务路由的目标免费模型（与 adaptiveRouter 保持一致） */
const FREE_MODEL = {
  provider: 'zhipu' as ModelProvider,
  model: DEFAULT_MODELS.quick,
};

function extractMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .map((part) => {
      if (part.type === 'text') return part.text ?? '';
      if (part.type === 'compaction') return part.compaction ?? '';
      return '';
    })
    .join('\n');
}

function hasImageContent(message: ModelMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === 'image');
}

function detectCapabilityNeeds(messages: ModelMessage[]): ModelCapabilityNeed[] {
  const needs = new Set<ModelCapabilityNeed>();
  const text = messages.map(extractMessageText).join('\n').toLowerCase();

  if (messages.some(hasImageContent)) {
    needs.add('vision');
  }

  if (messages.some((message) => (message.toolCalls?.length ?? 0) > 0 || Boolean(message.toolCallId || message.toolCallText))) {
    needs.add('tool-use');
  }

  if (/```|重构|修复|实现|代码|测试|函数|组件|\b(hook|api|repo|typescript|javascript|python|bug|diff)\b/.test(text)) {
    needs.add('code');
  }

  if (/搜索|查找|联网|最新|官网|release note|news|price|weather|search|browse|web/.test(text)) {
    needs.add('search');
  }

  if (/artifact|图表|表格|文档|报告|ppt|excel|dashboard|生成文件|导出/.test(text)) {
    needs.add('artifact');
  }

  if (/长上下文|大文件|整个项目|全仓|多文件|大量文件|long context|large context/.test(text)) {
    needs.add('long-context');
  }

  return Array.from(needs);
}

function inferTaskClass(needs: ModelCapabilityNeed[], complexityLevel?: string): ModelTaskClass {
  if (needs.includes('vision')) return 'vision';
  if (needs.includes('artifact')) return 'artifact';
  if (needs.includes('long-context')) return 'long-context';
  if (needs.includes('code')) return 'coding';
  if (needs.includes('search')) return 'search';
  if (needs.includes('tool-use')) return 'multi-tool';
  if (complexityLevel === 'simple') return 'simple';
  return 'unknown';
}

function resolveCostPolicy(
  reason: ModelDecisionReason,
  billingMode: BillingMode,
  adaptiveEnabled: boolean,
): ModelCostPolicy {
  if (reason === 'simple-task-free') return 'save-cost';
  if (reason === 'billing-gate-skip') {
    return billingMode === 'unknown' ? 'unknown-conservative' : 'plan-no-savings';
  }
  if (reason === 'user-selected' && !adaptiveEnabled) return 'user-locked';
  return 'neutral';
}

function resolveSpeedPolicy(
  reason: ModelDecisionReason,
  providerHealthSnapshot: ModelProviderHealthSnapshot,
): ModelSpeedPolicy {
  if (reason === 'simple-task-free') return 'fast-path';
  if (reason === 'fallback-availability') return 'fallback-recovery';
  if (
    providerHealthSnapshot.status === 'degraded'
    || providerHealthSnapshot.status === 'unavailable'
    || providerHealthSnapshot.status === 'recovering'
  ) {
    return 'provider-degraded';
  }
  return 'normal';
}

function resolveToolPolicy(needs: ModelCapabilityNeed[]): ModelToolPolicy | undefined {
  return needs.length > 0 ? 'runtime-checked' : undefined;
}

function buildStrategySummary(params: {
  reason: ModelDecisionReason;
  billingMode: BillingMode;
  role: string | null;
  adaptiveEnabled: boolean;
  taskClass: ModelTaskClass;
}): string {
  const { reason, billingMode, role, adaptiveEnabled, taskClass } = params;
  switch (reason) {
    case 'role-tier':
      return `按 ${role ?? 'subagent'} 角色档位选择主任务模型。`;
    case 'simple-task-free':
      return '识别为简单任务，按量计费下切到快模型降低成本和延迟。';
    case 'billing-gate-skip':
      if (billingMode === 'unknown') {
        return '识别为简单任务，但 provider 计费方式未知，保守沿用主任务模型。';
      }
      return '识别为简单任务，但当前计费方式切换快模型没有实际节省，沿用主任务模型。';
    case 'capability-vision':
      return '识别到视觉输入，选择具备视觉能力的主任务模型。';
    case 'fallback-availability':
      return '原模型不可用，切到可用模型完成当前任务。';
    case 'strategy-fast':
      return '任务策略选择快速模型，优先降低等待时间。';
    case 'strategy-main':
      return '任务策略选择主模型，平衡速度和质量。';
    case 'strategy-deep':
      return '任务策略选择深度模型，优先保证复杂任务质量。';
    case 'strategy-vision':
      return '任务策略选择视觉模型，处理图片或多模态输入。';
    case 'default-model':
      return '使用默认模型，未做自动切换。';
    case 'user-selected':
    default:
      if (!adaptiveEnabled) {
        return '使用用户选定的主任务模型，未做自动切换。';
      }
      if (taskClass !== 'simple' && taskClass !== 'unknown') {
        return '当前任务需要更完整的能力，沿用主任务模型保证输出质量。';
      }
      return '当前轮沿用主任务模型。';
  }
}

function buildProviderHealthSnapshot(provider: string): ModelProviderHealthSnapshot {
  const health = getProviderHealthMonitor().getHealth(provider);
  const sampledAt = Date.now();
  if (!health) {
    return {
      provider,
      status: 'unknown',
      sampledAt,
    };
  }

  return {
    provider: health.provider,
    status: health.status,
    sampledAt,
    latencyP50: health.latencyP50,
    latencyP95: health.latencyP95,
    errorRate: health.errorRate,
    lastSuccessAt: health.lastSuccessAt,
    lastErrorAt: health.lastErrorAt,
    consecutiveErrors: health.consecutiveErrors,
  };
}

const STRATEGY_REASON_BY_PROFILE: Record<TaskStrategyProfileId, ModelDecisionReason> = {
  fast: 'strategy-fast',
  main: 'strategy-main',
  deep: 'strategy-deep',
  vision: 'strategy-vision',
};

function hasVisionInput(messages: ModelMessage[]): boolean {
  const lastUserMsg = [...messages].reverse().find((message) => message.role === 'user');
  return Array.isArray(lastUserMsg?.content) && lastUserMsg.content.some((part) => part.type === 'image');
}

function messageText(messages: ModelMessage[]): string {
  const lastUserMsg = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUserMsg) return '';
  if (typeof lastUserMsg.content === 'string') return lastUserMsg.content;
  if (Array.isArray(lastUserMsg.content)) {
    return lastUserMsg.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join(' ');
  }
  return '';
}

function inferStrategyIntent(
  messages: ModelMessage[],
  complexity: TaskComplexity,
): TaskStrategyRuleIntent {
  if (hasVisionInput(messages)) return 'vision';

  const text = messageText(messages).toLowerCase();
  if (complexity.level === 'complex' || /研究|规划|方案|重构|架构|对标|分析|audit|review|refactor|architect|migrate|benchmark/.test(text)) {
    return 'research';
  }
  if (/```|\.tsx?|\.jsx?|\.py|\.go|\.rs|\.java|\.css|\.html|package\.json|tsconfig|readme|代码|文件|修复|实现|测试|改/.test(text)) {
    return 'coding';
  }
  if (complexity.level === 'simple') return 'simple_chat';
  return 'coding';
}

function findEnabledStrategyRule(
  strategy: TaskModelStrategySettings,
  intent: TaskStrategyRuleIntent,
): TaskStrategyRuleSettings | undefined {
  return strategy.rules.find((rule) => rule.enabled && rule.intent === intent);
}

function resolveStrategyProfile(
  strategy: TaskModelStrategySettings,
  intent: TaskStrategyRuleIntent,
): { profile: TaskStrategyProfileId; rule?: TaskStrategyRuleSettings } {
  const rule = findEnabledStrategyRule(strategy, intent);
  if (rule) return { profile: rule.profile, rule };
  return { profile: strategy.defaultProfile || 'main' };
}

function applyStrategySlot(
  requestedConfig: ModelConfig,
  strategy: TaskModelStrategySettings,
  profile: TaskStrategyProfileId,
): ModelConfig {
  const slot = strategy.profiles?.[profile] || strategy.profiles?.main;
  if (!slot) return requestedConfig;
  return {
    ...requestedConfig,
    provider: slot.provider,
    model: slot.model,
    reasoningEffort: slot.reasoningEffort ?? requestedConfig.reasoningEffort,
    maxTokens: slot.maxTokens ?? requestedConfig.maxTokens,
    adaptive: strategy.fallback.enabled && strategy.fallback.allowCrossProvider
      ? requestedConfig.adaptive
      : false,
  };
}

/**
 * 判定 provider 的计费方式（ADR-019 决策 4 + 6.2）。
 *
 * 优先级：用户配置 > 类型默认值。
 * 默认值贴近现实：普通 provider 默认按量付费（API Key 主流形态，省钱路由默认生效）；
 * 动态 custom provider（中转站）默认 unknown（保守，不参与省钱路由）。
 * 配错的代价不对称：包月被当按量 = 没省到钱但不多花钱；按量不路由 = 损失真实节省。
 */
export function resolveProviderBillingMode(
  provider: string,
  providers: Record<string, Pick<ModelProviderSettings, 'enabled' | 'billingMode'>> | undefined,
): BillingMode {
  const configured = providers?.[provider]?.billingMode;
  if (configured) return configured;
  return isDynamicCustomProviderId(provider) ? 'unknown' : 'payg';
}

export function buildModelProviderIdentity(
  provider: string,
  providers: Record<string, ModelDecisionProviderSettings> | undefined,
): ModelProviderIdentity | undefined {
  const providerConfig = providers?.[provider];
  const endpoint = providerConfig?.baseUrl?.trim();
  const displayName = providerConfig?.displayName?.trim();
  const isCustomProvider = provider === 'custom' || isDynamicCustomProviderId(provider);
  const shouldExposeIdentity = isCustomProvider || Boolean(endpoint) || Boolean(displayName && displayName !== provider);
  if (!shouldExposeIdentity) return undefined;

  const protocol = resolveProviderProtocol(provider, providerConfig);
  const sourceLabel = isCustomProvider ? displayName || provider : undefined;
  return {
    provider,
    ...(displayName ? { displayName } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
    protocol,
    transportLabel: formatProviderProtocolLabel(protocol),
    ...(endpoint ? { endpoint } : {}),
  };
}

// ----------------------------------------------------------------------------
// 档位 → 实际模型解析（ADR-019 修正 1：分发版无硬编码）
// ----------------------------------------------------------------------------

/** 档位解析所需的用户配置切片（纯数据，调用方从 configService 取后注入） */
export interface TierResolutionSettings {
  defaultProvider?: string;
  defaultModel?: string;
  providers?: Record<string, Pick<ModelProviderSettings, 'enabled' | 'apiKey' | 'apiKeyConfigured' | 'billingMode'>>;
  /** 用户在设置里指定的"快速模型"偏好（settings.models.routing.fast） */
  routingFast?: { provider: string; model: string };
}

function isProviderUsable(provider: string, settings: TierResolutionSettings): boolean {
  const p = settings.providers?.[provider];
  if (!p) return false;
  if (p.enabled === false) return false;
  return !!p.apiKey || !!p.apiKeyConfigured;
}

/**
 * 角色档位 → 实际模型。
 *
 * 解析顺序：
 * - powerful（主力档）= 用户默认模型，永不硬编码厂商
 * - fast：用户 routing.fast 偏好 → 内置免费推荐（需用户配了该 provider 的 key）→ 用户默认模型
 * - balanced：内置标准推荐（需用户配了 key）→ 用户默认模型
 * - 无 settings（测试/CLI 环境）：沿用内置默认，行为不变
 *
 * override（专家详情页「指定具体模型」）优先于档位，但同样要过 provider 可用性检查：
 * 用户后来删了那家 key，专家不会因此瘫掉，而是回落到档位解析。
 *
 * 核心保证：分发给任何用户都不会因为"没配某个特定厂商的 key"而让 subagent 直接坏掉。
 */
export function resolveTierModelConfig(
  tier: 'fast' | 'balanced' | 'powerful',
  builtinDefault: { provider: string; model: string },
  settings: TierResolutionSettings | undefined,
  override?: { provider: string; model: string },
): { provider: ModelProvider; model: string } {
  if (!settings) {
    return builtinDefault as { provider: ModelProvider; model: string };
  }

  if (override) {
    if (isProviderUsable(override.provider, settings)) {
      return override as { provider: ModelProvider; model: string };
    }
    logger.info(`[ModelDecision] 指定模型 ${override.provider}/${override.model} 的 provider 未配置，回落到档位 ${tier}`);
  }

  const userDefault = {
    provider: (settings.defaultProvider ?? builtinDefault.provider) as ModelProvider,
    model: settings.defaultModel ?? builtinDefault.model,
  };

  // 主力档 = 用户默认模型（分发核心：不硬编码任何厂商）
  if (tier === 'powerful') {
    return userDefault;
  }

  // fast 档：用户 routing 偏好优先
  if (tier === 'fast' && settings.routingFast && isProviderUsable(settings.routingFast.provider, settings)) {
    return settings.routingFast as { provider: ModelProvider; model: string };
  }

  // 内置推荐：用户配了对应 provider 的 key 才用
  if (isProviderUsable(builtinDefault.provider, settings)) {
    return builtinDefault as { provider: ModelProvider; model: string };
  }

  // 该档位的 provider 用户没配 → 降级到用户默认模型（保证能跑）
  logger.info(`[ModelDecision] tier=${tier} 内置推荐 ${builtinDefault.provider} 未配置，降级到用户默认模型 ${userDefault.provider}/${userDefault.model}`);
  return userDefault;
}

/**
 * 单一路由决策入口。
 *
 * 硬规则（ADR-019）：
 * 1. subagent 路径永远剥离 adaptive —— 角色分层是确定性映射，不被 adaptive 覆盖
 * 2. simple → 免费档路由仅在 billingMode === 'payg' 时生效（包月用户省的钱是 0）
 * 3. 永不向上：本函数所有切换只会切到免费档，不会切到更贵的模型
 */
export function resolveModelDecision(input: ModelDecisionInput): ModelDecisionResult {
  const { requestedConfig, messages, context, subagentRole, taskStrategy } = input;
  const billingMode: BillingMode = input.billingMode ?? 'payg';
  const capabilityNeeds = detectCapabilityNeeds(messages);
  const toolPolicy = resolveToolPolicy(capabilityNeeds);
  const adaptiveEnabled = requestedConfig.adaptive === true;

  const base: Omit<ModelDecision, 'reason' | 'resolvedProvider' | 'resolvedModel'> = {
    requestedProvider: requestedConfig.provider,
    requestedModel: requestedConfig.model,
    role: subagentRole ?? null,
    billingMode,
    fallbackFrom: null,
  };
  const buildDecision = (
    reason: ModelDecisionReason,
    resolvedProvider: string,
    resolvedModel: string,
    complexity?: TaskComplexity,
    strategy?: {
      profile?: TaskStrategyProfileId;
      ruleId?: string;
      reason?: string;
    },
  ): ModelDecision => {
    const taskClass = inferTaskClass(capabilityNeeds, complexity?.level);
    const providerHealthSnapshot = buildProviderHealthSnapshot(resolvedProvider);
    const providerIdentity = buildModelProviderIdentity(resolvedProvider, input.providerSettings);
    return {
      ...base,
      resolvedProvider,
      resolvedModel,
      reason,
      strategySummary: buildStrategySummary({
        reason,
        billingMode,
        role: base.role,
        adaptiveEnabled,
        taskClass,
      }),
      taskClass,
      costPolicy: resolveCostPolicy(reason, billingMode, adaptiveEnabled),
      speedPolicy: resolveSpeedPolicy(reason, providerHealthSnapshot),
      providerHealthSnapshot,
      ...(providerIdentity ? { providerIdentity } : {}),
      ...(complexity ? { complexityScore: complexity.score, taskComplexity: complexity } : {}),
      ...(strategy?.profile ? { strategyProfile: strategy.profile } : {}),
      ...(strategy?.ruleId ? { strategyRuleId: strategy.ruleId } : {}),
      ...(strategy?.reason ? { strategyReason: strategy.reason } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      ...(capabilityNeeds.length > 0 ? { capabilityNeeds } : {}),
    };
  };

  // ---- 1. subagent 路径：剥离 adaptive，角色分层即最终决策 ----
  if (context === 'subagent') {
    return {
      config: { ...requestedConfig, adaptive: false },
      decision: buildDecision('role-tier', requestedConfig.provider, requestedConfig.model),
    };
  }

  // ---- 2. 主聊天：adaptive 关闭 → 直连 ----
  // 默认模型（用户从未手动改过）不应标成「用户选择」，否则 trace chip 会误报
  // “用户选择 mimo”。只有真正切到非默认模型才算 user-selected。
  if (requestedConfig.adaptive !== true) {
    const directReason: ModelDecisionReason = isDefaultModelConfig(requestedConfig)
      ? 'default-model'
      : 'user-selected';
    return {
      config: requestedConfig,
      decision: buildDecision(directReason, requestedConfig.provider, requestedConfig.model),
    };
  }

  const complexity = getAdaptiveRouter().estimateComplexity(messages);

  if (taskStrategy) {
    const intent = taskStrategy.mode === 'manual'
      ? 'coding'
      : inferStrategyIntent(messages, complexity);
    const { profile, rule } = taskStrategy.mode === 'manual'
      ? { profile: (taskStrategy.defaultProfile || 'main') as TaskStrategyProfileId, rule: undefined }
      : resolveStrategyProfile(taskStrategy, intent);
    const decidedConfig = applyStrategySlot(requestedConfig, taskStrategy, profile);
    const reason = STRATEGY_REASON_BY_PROFILE[profile] || 'strategy-main';
    return {
      config: decidedConfig,
      decision: buildDecision(reason, decidedConfig.provider, decidedConfig.model, complexity, {
        profile,
        ruleId: rule?.id,
        reason: rule?.reason || `使用 ${profile} 任务策略`,
      }),
    };
  }

  // ---- 3. 主聊天 + adaptive：简单任务 → 免费档（计费门控） ----
  const alreadyFree = requestedConfig.provider === FREE_MODEL.provider
    && requestedConfig.model === FREE_MODEL.model;

  if (complexity.level === 'simple' && !alreadyFree) {
    if (billingMode !== 'payg') {
      // 包月/订阅/未知：切免费模型省的钱是 0，跳过（ADR-019 决策 2）
      logger.info(`[ModelDecision] simple task but billing=${billingMode}, skip free routing`);
      return {
        config: requestedConfig,
        decision: buildDecision('billing-gate-skip', requestedConfig.provider, requestedConfig.model, complexity),
      };
    }

    logger.info(`[ModelDecision] simple task → ${FREE_MODEL.provider}/${FREE_MODEL.model} (score=${complexity.score})`);
    return {
      config: { ...requestedConfig, provider: FREE_MODEL.provider, model: FREE_MODEL.model },
      decision: buildDecision('simple-task-free', FREE_MODEL.provider, FREE_MODEL.model, complexity, {
        profile: 'fast',
        ruleId: 'legacy-simple-task-free',
        reason: '简单任务使用快速免费模型',
      }),
    };
  }

  // ---- 4. 其余情况：保持请求模型（adaptive 开但未触发路由）----
  const keepReason: ModelDecisionReason = isDefaultModelConfig(requestedConfig)
    ? 'default-model'
    : 'user-selected';
  return {
    config: requestedConfig,
    decision: buildDecision(keepReason, requestedConfig.provider, requestedConfig.model, complexity),
  };
}

/** 是否为应用默认模型（用户从未手动切换过）。用于把默认路径与真实用户选择区分开。 */
function isDefaultModelConfig(config: ModelConfig): boolean {
  return config.provider === DEFAULT_PROVIDER && config.model === DEFAULT_MODEL;
}
