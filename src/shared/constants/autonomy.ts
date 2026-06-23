// ADR-027 设计画布有界自主 · 信封常量（禁硬编码：默认/天花板/安全系数收口此处）。
// 信封 = {maxVariants, maxCny}，预算账逻辑在 shared/contract/designAutonomy.ts。

/** agent 未指定时的默认扇出变体数（设计师「3 个方向」的经验值）。 */
export const DEFAULT_AUTONOMY_VARIANTS = 3;

/** 单次自主信封的绝对变体天花板（信封再大不可超，防失控；红线①）。 */
export const MAX_AUTONOMY_VARIANTS = 5;

/**
 * 派生默认 ¥ 上限的安全系数：默认 maxCny = maxVariants × 单张 t2i 估价 × 系数。
 * >1 留 re-roll/估价偏差头寸，使**变体上限先于 ¥ 上限绑定**（¥ 是兜底安全网，不是主约束）。
 */
export const AUTONOMY_CNY_SAFETY_FACTOR = 1.5;
