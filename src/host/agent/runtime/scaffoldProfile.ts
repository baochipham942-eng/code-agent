// ============================================================================
// Scaffold Profile — 模型能力档 → 脚手架厚度映射（B7，spec 见 private-archive）
//
// 立场：程序化验证闸（证据闸/verify/review）不裁剪——那是零 LLM 成本的质量底线；
// 分档裁剪的只有 per-turn prompt 注入税（thinking 注入、goal 审计 nudge 频率）。
// strong 档模型自带 reasoning，<thinking> 注入是重复税；nudge 过频则脱敏。
// ============================================================================

import { SCAFFOLD_PROFILE } from '../../../shared/constants/agent';
import { getModelScaffoldTier, type ScaffoldTier } from '../../../shared/constants/models';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ScaffoldProfile');
let scaffoldProfileOverride: boolean | undefined;

export function setScaffoldProfileOverride(value: boolean | undefined): void {
  scaffoldProfileOverride = value;
}

export function getScaffoldProfileOverride(): boolean | undefined {
  return scaffoldProfileOverride;
}

// 单维度实验旋钮：只覆盖 thinkingInjection，nudge/修复指令不动。
// 2026-07-11 非劣批 B7 整套 profile 两模型腿同向回退，需定位是三件里哪件在伤成功率。
let thinkingInjectionOverride: boolean | undefined;

export function setThinkingInjectionOverride(value: boolean | undefined): void {
  thinkingInjectionOverride = value;
}

export function getThinkingInjectionOverride(): boolean | undefined {
  return thinkingInjectionOverride;
}

export type RepairInstructionStyle = 'full' | 'compact';

export interface ScaffoldProfile {
  tier: ScaffoldTier;
  /** false = 关闭 per-turn <thinking> 提示注入（模型自带 reasoning 时为重复税） */
  thinkingInjection: boolean;
  /** goal 审计 nudge 间隔倍率（strong=2 拉长一倍，standard/lite=1 现状） */
  auditNudgeIntervalMultiplier: number;
  /** 产物修复指令密度（strong=compact 失败项清单+一行指令，standard/lite=full 现状长版） */
  repairInstructionStyle: RepairInstructionStyle;
}

/** standard 档 = 现状行为逐字不变（未标注模型、flag 关闭时的唯一出口） */
const STANDARD_PROFILE: ScaffoldProfile = {
  tier: 'standard',
  thinkingInjection: true,
  auditNudgeIntervalMultiplier: 1,
  repairInstructionStyle: 'full',
};

export function resolveScaffoldProfile(tier: ScaffoldTier): ScaffoldProfile {
  switch (tier) {
    case 'strong':
      return { tier, thinkingInjection: false, auditNudgeIntervalMultiplier: 2, repairInstructionStyle: 'compact' };
    // lite 档 P0 与 standard 同行为（加厚不在本期），仅数据标注先行
    case 'lite':
      return { ...STANDARD_PROFILE, tier };
    default:
      return STANDARD_PROFILE;
  }
}

/**
 * 按模型解析 profile。flag 关闭时恒返 standard（现状），保证默认零行为变化。
 * 消费方只读 profile 字段，禁止各处自查 tier（单一真源，防多处判定漂移）。
 */
export function resolveScaffoldProfileForModel(modelId: string): ScaffoldProfile {
  const override = getScaffoldProfileOverride();
  const enabled = override ?? SCAFFOLD_PROFILE.ENABLED;
  const base = enabled ? resolveScaffoldProfile(getModelScaffoldTier(modelId)) : STANDARD_PROFILE;
  if (override === true) {
    logger.info(`[scaffold-profile] arm override active: on tier=${base.tier}`);
  }
  const thinkingOverride = getThinkingInjectionOverride();
  if (thinkingOverride !== undefined) {
    logger.info(`[scaffold-profile] thinking-injection override active: ${thinkingOverride ? 'on' : 'off'}`);
    return { ...base, thinkingInjection: thinkingOverride };
  }
  return base;
}
