// ============================================================================
// 设计画布有界自主 · 信封预算账（纯逻辑）—— ADR-027
// ----------------------------------------------------------------------------
// 信封 = 用户一次性批准的「目标 + 预算」：{maxVariants, maxCny}，双上限先到先停。
// 这是替代「逐张点头」的**付费预授权**；¥ 上限是神圣硬线，est 闸在付费前拦（红线①）。
// 纯函数、无副作用、自包含——main 工具与 renderer 自主放行共用同一账本逻辑。
// ============================================================================
import { estimateImageCostCny } from '../media/imageCost';
import {
  DEFAULT_AUTONOMY_VARIANTS,
  MAX_AUTONOMY_VARIANTS,
  AUTONOMY_CNY_SAFETY_FACTOR,
} from '../constants/autonomy';

/** 浮点 ¥ 比较容差（价表是两位小数级，1e-9 足够吸收累加误差）。 */
const EPS = 1e-9;

/** agent/人提议的信封（两上限均可选，缺省由系统派生）。 */
export interface AutonomyGrant {
  maxVariants?: number;
  maxCny?: number;
}

/** 一个已授权、带消费态的信封（renderer 持有，跨多次自主放行存活）。 */
export interface AutonomyEnvelope {
  /** 本信封批准的最大成功变体数。 */
  maxVariants: number;
  /** 本信封批准的最大花费（¥）。 */
  maxCny: number;
  /** 已成功落地的变体数（失败不计，D2）。 */
  usedVariants: number;
  /** 已实际花费（¥，actual；含偶发失败扣费，账永远诚实）。 */
  spentCny: number;
}

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** 变体数夹紧到 [1, MAX_AUTONOMY_VARIANTS]，向下取整；非法回落默认值再夹紧。 */
export function clampVariants(n: unknown): number {
  const base = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_AUTONOMY_VARIANTS;
  return Math.min(MAX_AUTONOMY_VARIANTS, Math.max(1, base));
}

/** 系统派生的默认信封（变体数默认值 + 价表派生 ¥，含安全系数）。 */
export function defaultAutonomyGrant(model?: string): Required<AutonomyGrant> {
  const maxVariants = DEFAULT_AUTONOMY_VARIANTS;
  const perImage = estimateImageCostCny(model);
  const maxCny = maxVariants * perImage * AUTONOMY_CNY_SAFETY_FACTOR;
  return { maxVariants, maxCny };
}

/**
 * 授权一个信封：变体数夹紧 [1, MAX]；¥ 取显式正值，否则派生默认。
 * model 用于派生默认 ¥（命中价表取实价，未知回退 default）。
 */
export function grantEnvelope(grant: AutonomyGrant, model?: string): AutonomyEnvelope {
  const fallback = defaultAutonomyGrant(model);
  const maxVariants =
    grant.maxVariants === undefined || !Number.isFinite(grant.maxVariants)
      ? fallback.maxVariants
      : clampVariants(grant.maxVariants);
  const maxCny = isPositiveFinite(grant.maxCny) ? grant.maxCny : fallback.maxCny;
  return { maxVariants, maxCny, usedVariants: 0, spentCny: 0 };
}

/** 剩余变体数与 ¥（均非负，供 agent 回灌与 UI 展示）。 */
export function remaining(env: AutonomyEnvelope): { variants: number; cny: number } {
  return {
    variants: Math.max(0, env.maxVariants - env.usedVariants),
    cny: Math.max(0, env.maxCny - env.spentCny),
  };
}

/** 信封是否耗尽（变体上限触顶 或 ¥ 花光）——粗粒度停止信号，与下一张成本无关。 */
export function isExhausted(env: AutonomyEnvelope): boolean {
  return env.usedVariants >= env.maxVariants || env.spentCny + EPS >= env.maxCny;
}

/**
 * 付费前置闸（红线①）：还有变体槽 ∧ 这张的预估 ¥ 不超剩余 ¥ 才放行。
 * 任一不满足即拒该张——预算硬天花板，不超花。
 */
export function canAfford(env: AutonomyEnvelope, estCny: number): boolean {
  if (env.usedVariants >= env.maxVariants) return false;
  const est = Number.isFinite(estCny) && estCny > 0 ? estCny : 0;
  return env.spentCny + est <= env.maxCny + EPS;
}

/**
 * 消费一张生成的结果（返回新信封，纯函数不改原对象）：
 * - landed=true：吃一个变体槽 + 累加实际 ¥。
 * - landed=false：不吃变体槽（D2 失败不占版本上限），但若仍被扣费则 ¥ 照实累加（账诚实）。
 */
export function consume(
  env: AutonomyEnvelope,
  result: { landed: boolean; costCny: number },
): AutonomyEnvelope {
  const cost = Number.isFinite(result.costCny) && result.costCny > 0 ? result.costCny : 0;
  return {
    ...env,
    usedVariants: env.usedVariants + (result.landed ? 1 : 0),
    spentCny: env.spentCny + cost,
  };
}

// ── 信封审批 IPC 契约（main 工具 ↔ renderer 审批面板）──

/** main → renderer：agent 请求一个自主信封（人审批/可改）。 */
export interface AutonomyEnvelopeRequest {
  requestId: string;
  /** agent 的目标一句话（给人看「要自主做什么」）。 */
  goal: string;
  /** agent 提议的信封（两上限可选；人可改）。 */
  proposed: AutonomyGrant;
  rationale?: string;
}

/** renderer → main：人对信封请求的裁决。 */
export interface AutonomyEnvelopeDecision {
  requestId: string;
  /** grant=批准（granted 为人最终确认的信封）；decline=不批。 */
  verdict: 'grant' | 'decline';
  /** verdict=grant 时人最终批准的信封（可能已改 agent 提议值）。 */
  granted?: AutonomyGrant;
  feedback?: string;
}
