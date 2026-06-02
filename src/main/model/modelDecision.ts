// ============================================================================
// Model Decision - 单一路由决策入口（ADR-019）
//
// 所有模型路由决策（主聊天 adaptive / subagent 角色分层）的唯一出口。
// 输出结构化决策对象，UI trace / 日志 / 成本统计统一消费这个对象，
// 消除"两条引擎、两种行为"和 adaptive 标志泄漏问题。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ModelConfig, ModelProvider } from '../../shared/contract';
import type { ModelProviderSettings } from '../../shared/contract/settings';
import type { BillingMode, ModelDecision, ModelDecisionReason } from '../../shared/contract/modelDecision';
import type { ModelMessage } from './types';
import { DEFAULT_MODELS } from '../../shared/constants';
import { isDynamicCustomProviderId } from '../../shared/modelRuntime';
import { getAdaptiveRouter } from './adaptiveRouter';

const logger = createLogger('ModelDecision');

export type { BillingMode, ModelDecision, ModelDecisionReason } from '../../shared/contract/modelDecision';

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
 * 核心保证：分发给任何用户都不会因为"没配某个特定厂商的 key"而让 subagent 直接坏掉。
 */
export function resolveTierModelConfig(
  tier: 'fast' | 'balanced' | 'powerful',
  builtinDefault: { provider: string; model: string },
  settings: TierResolutionSettings | undefined,
): { provider: ModelProvider; model: string } {
  if (!settings) {
    return builtinDefault as { provider: ModelProvider; model: string };
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
  const { requestedConfig, messages, context, subagentRole } = input;
  const billingMode: BillingMode = input.billingMode ?? 'payg';

  const base: Omit<ModelDecision, 'reason' | 'resolvedProvider' | 'resolvedModel'> = {
    requestedProvider: requestedConfig.provider,
    requestedModel: requestedConfig.model,
    role: subagentRole ?? null,
    billingMode,
    fallbackFrom: null,
  };

  // ---- 1. subagent 路径：剥离 adaptive，角色分层即最终决策 ----
  if (context === 'subagent') {
    return {
      config: { ...requestedConfig, adaptive: false },
      decision: {
        ...base,
        resolvedProvider: requestedConfig.provider,
        resolvedModel: requestedConfig.model,
        reason: 'role-tier',
      },
    };
  }

  // ---- 2. 主聊天：adaptive 关闭 → 用户指定直连 ----
  if (requestedConfig.adaptive !== true) {
    return {
      config: requestedConfig,
      decision: {
        ...base,
        resolvedProvider: requestedConfig.provider,
        resolvedModel: requestedConfig.model,
        reason: 'user-selected',
      },
    };
  }

  // ---- 3. 主聊天 + adaptive：简单任务 → 免费档（计费门控） ----
  const complexity = getAdaptiveRouter().estimateComplexity(messages);
  const alreadyFree = requestedConfig.provider === FREE_MODEL.provider
    && requestedConfig.model === FREE_MODEL.model;

  if (complexity.level === 'simple' && !alreadyFree) {
    if (billingMode !== 'payg') {
      // 包月/订阅/未知：切免费模型省的钱是 0，跳过（ADR-019 决策 2）
      logger.info(`[ModelDecision] simple task but billing=${billingMode}, skip free routing`);
      return {
        config: requestedConfig,
        decision: {
          ...base,
          resolvedProvider: requestedConfig.provider,
          resolvedModel: requestedConfig.model,
          reason: 'billing-gate-skip',
        },
      };
    }

    logger.info(`[ModelDecision] simple task → ${FREE_MODEL.provider}/${FREE_MODEL.model} (score=${complexity.score})`);
    return {
      config: { ...requestedConfig, provider: FREE_MODEL.provider, model: FREE_MODEL.model },
      decision: {
        ...base,
        resolvedProvider: FREE_MODEL.provider,
        resolvedModel: FREE_MODEL.model,
        reason: 'simple-task-free',
      },
    };
  }

  // ---- 4. 其余情况：保持用户指定 ----
  return {
    config: requestedConfig,
    decision: {
      ...base,
      resolvedProvider: requestedConfig.provider,
      resolvedModel: requestedConfig.model,
      reason: 'user-selected',
    },
  };
}
