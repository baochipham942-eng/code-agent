// ============================================================================
// Model Decision - 单一路由决策入口（ADR-019）
//
// 所有模型路由决策（主聊天 adaptive / subagent 角色分层）的唯一出口。
// 输出结构化决策对象，UI trace / 日志 / 成本统计统一消费这个对象，
// 消除"两条引擎、两种行为"和 adaptive 标志泄漏问题。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ModelConfig, ModelProvider } from '../../shared/contract';
import type { ModelMessage } from './types';
import { DEFAULT_MODELS } from '../../shared/constants';
import { getAdaptiveRouter } from './adaptiveRouter';

const logger = createLogger('ModelDecision');

/** Provider 计费方式（ADR-019 决策 4：计费语义四分类） */
export type BillingMode = 'free' | 'plan' | 'payg' | 'unknown';

/** 决策原因 — UI trace 文案和日志都从这里派生 */
export type ModelDecisionReason =
  | 'user-selected'          // 用户指定模型，未干预
  | 'role-tier'              // subagent 角色分层（确定性映射）
  | 'simple-task-free'       // 简单任务 → 免费档（仅按量付费时）
  | 'billing-gate-skip'      // 简单任务但计费门控跳过（包月/未知，省的钱 = 0）
  | 'capability-vision'      // 视觉能力兜底
  | 'fallback-availability'; // 可用性降级（限流/网络/余额）

/** 结构化路由决策 — 唯一出口对象 */
export interface ModelDecision {
  requestedProvider: string;
  requestedModel: string;
  resolvedProvider: string;
  resolvedModel: string;
  /** subagent 角色（explore/coder 等），主聊天为 null */
  role: string | null;
  reason: ModelDecisionReason;
  billingMode: BillingMode;
  /** 可用性降级时记录降级前的模型，其余为 null */
  fallbackFrom: string | null;
}

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
