// ============================================================================
// service_tier 档位解析（N-MODELCAT-SERVICE-TIER-WIRE）
//
// 无人值守 run 的半价档机制：run 接缝（agentLoop 构造）按 scope 决定挂不挂档，
// 评审路径强制 standard。档位值与拒绝信号集的单一源在 shared/constants/serviceTier。
// ============================================================================

import type { ModelConfig } from '../../shared/contract';
import { UNATTENDED_SERVICE_TIER } from '../../shared/constants';

/**
 * 纯解析，无 IO：
 * - isReview → 恒无档（评审强制 standard，standard 用「字段缺席」表示）；
 * - parentTier 给定（子代理继承根会话的档位）→ 原样继承；
 * - scope 'unattended' → 半价档常量；其余（'default'）→ 无档。
 */
export function resolveServiceTier(
  scope: 'unattended' | 'default',
  parentTier?: string,
  isReview?: boolean,
): string | undefined {
  if (isReview) return undefined;
  if (parentTier !== undefined) return parentTier;
  return scope === 'unattended' ? UNATTENDED_SERVICE_TIER : undefined;
}

/** 按裁决重写 config.serviceTier；undefined 时保证字段缺席（不留在场为 undefined）。 */
export function withServiceTier(config: ModelConfig, tier: string | undefined): ModelConfig {
  if (tier === undefined) {
    if (config.serviceTier === undefined) return config;
    const { serviceTier: _stripped, ...rest } = config;
    return rest;
  }
  return config.serviceTier === tier ? config : { ...config, serviceTier: tier };
}

/**
 * run 接缝：无人值守（unattendedTurn 或 budgetScope='unattended'，goalMode 不算——
 * 前台 goal run 用户在等结果，不该吃慢档）且 provider 为 openai 才挂半价档。
 * 其余 provider——含 deepseek 走 Responses 的——一律无档，请求体保持逐字节不变。
 */
export function applyRunServiceTier(config: ModelConfig, unattended: boolean): ModelConfig {
  if (config.provider !== 'openai') return withServiceTier(config, undefined);
  return withServiceTier(config, resolveServiceTier(unattended ? 'unattended' : 'default', config.serviceTier));
}
