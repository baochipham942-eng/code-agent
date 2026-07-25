// ============================================================================
// 模型价格证据等级解析（2026-07-23 设计定稿 · 2026-07-25 费曼审计 P1-2 实施）
// ============================================================================
//
// 核心原则（设计稿 §1.1）：
//   1. 价格不来自 API Key——渠道身份 + 模型 id + 价目表 / 用户填写。
//   2. 未知价不编造：无权威单价 → source='unknown'，UI 显示 "—"，禁止兜底价。
//   3. 刊例 ≠ 账单：所有展示配「刊例估算，非实际账单」。
//   4. 1.0x 必须有锚点：基准模型可配置，默认见 PRICING_BASELINE_DEFAULT。
//
// 解析优先级：user 覆盖 > catalog 纠错表（MODEL_PRICING_PER_1M 策展价）>
// litellm 快照 > unknown。OpenRouter 实时价为 P1 扩展（快照里已含其刊例）。
// 快照刷新：scripts/generate-litellm-snapshot.mjs。
// ============================================================================

import { MODEL_PRICING_PER_1M } from '../constants/pricing';
import litellmSnapshot from './litellmSnapshot.json';

export type PriceSource = 'litellm' | 'openrouter' | 'catalog' | 'user' | 'unknown';

export interface ModelPrice {
  modelId: string;
  source: PriceSource;
  /** 每 1M input tokens 的 USD；unknown 时缺省 */
  inputPerMTok?: number;
  /** 每 1M output tokens 的 USD；unknown 时缺省 */
  outputPerMTok?: number;
  /** 价目数据时间（litellm 快照抓取日 / catalog 为发版内置） */
  updatedAt?: string;
}

/** key 为 "<provider>/<modelId>" 全 id（S4 用户填价落地时随设置项一起转正为导出契约） */
type PricingOverrides = Record<string, { inputPerMTok: number; outputPerMTok: number }>;

/** 输入/输出混合权重（设计稿 §5.1 默认） */
const PRICE_BLEND = { in: 0.3, out: 0.7 } as const;

/** 1.0x 基准锚点：目录内最常用中档国产模型（可被 settings.pricing.baselineModelId 覆盖） */
export const PRICING_BASELINE_DEFAULT = { provider: 'deepseek', modelId: 'deepseek-v4-pro' } as const;

interface SnapshotShape {
  fetchedAt: string;
  entries: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}
const snapshot = litellmSnapshot as unknown as SnapshotShape;

export function resolveModelPrice(
  provider: string,
  modelId: string,
  overrides?: PricingOverrides,
): ModelPrice {
  const fullId = `${provider}/${modelId}`;

  const user = overrides?.[fullId] ?? overrides?.[modelId];
  if (user) {
    return { modelId, source: 'user', inputPerMTok: user.inputPerMTok, outputPerMTok: user.outputPerMTok };
  }

  // catalog 纠错表：策展价（含免费档 0 与 Token Plan 包月 0——是「已知为 0」，不是未知）。
  // 'default' 是历史兜底键，不是价格证据，跳过。
  const curated = modelId !== 'default' ? MODEL_PRICING_PER_1M[modelId] : undefined;
  if (curated) {
    return { modelId, source: 'catalog', inputPerMTok: curated.input, outputPerMTok: curated.output };
  }

  // 本地推理不产生 API 账单
  if (provider === 'local') {
    return { modelId, source: 'catalog', inputPerMTok: 0, outputPerMTok: 0 };
  }

  const snap = snapshot.entries[fullId];
  if (snap) {
    return {
      modelId,
      source: 'litellm',
      inputPerMTok: snap.inputPerMTok,
      outputPerMTok: snap.outputPerMTok,
      updatedAt: snapshot.fetchedAt,
    };
  }

  return { modelId, source: 'unknown' };
}

/** 混合单价；价缺失 → null（整项 unknown，不做半价计算） */
function blendedPerMTok(price: ModelPrice): number | null {
  if (price.inputPerMTok === undefined || price.outputPerMTok === undefined) return null;
  return PRICE_BLEND.in * price.inputPerMTok + PRICE_BLEND.out * price.outputPerMTok;
}

/** 相对基准的倍率；任一侧无价或基准为 0 → null（UI 显示 "—"） */
export function computeCoef(price: ModelPrice, baseline: ModelPrice): number | null {
  const a = blendedPerMTok(price);
  const b = blendedPerMTok(baseline);
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

/** "0.25x" / "≈0x"（免费档）/ null（不渲染数字） */
export function formatCoefLabel(coef: number | null): string | null {
  if (coef === null) return null;
  if (coef < 0.005) return '≈0x';
  return `${coef.toFixed(2)}x`;
}

/** 本轮 USD 估算（仅文本 token，P0 范围）；无价 → null，禁止用兜底价装精确 */
export function estimateTurnCostUsd(
  price: ModelPrice,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  if (price.inputPerMTok === undefined || price.outputPerMTok === undefined) return null;
  return (usage.inputTokens / 1e6) * price.inputPerMTok
    + (usage.outputTokens / 1e6) * price.outputPerMTok;
}
