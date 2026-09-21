// ============================================================================
// Judge 校准计算 — 量化 LLM judge 与金标的真实一致度
// ============================================================================
// SwissCheese 的 LLM 打分若不校准，无法区分"agent 真变强"与"judge 被讨好"。
// 本模块把 judge 判定与金标判定（确定性断言结果 / 人工抽检）配对，输出：
//   - 混淆矩阵：FP=judge 虚高（说 pass 实为 fail），FN=judge 误杀
//   - Cohen's Kappa：去除随机一致后的真实一致度（比裸一致率更可信）
//   - 虚高率/误杀率：judge 的系统性偏向
//   - 分数 Pearson 相关 + 分歧清单（直接定位 judge 在哪类 case 上不可信）
// 金标可换源：本期用零人力的确定性断言，后续接入人工抽检即为最高可信度背书。
// ============================================================================

export type CalibrationLabel = 'pass' | 'fail';

export interface CalibrationPair {
  caseId: string;
  /** LLM judge（如 SwissCheese）的二值判定 */
  judgeLabel: CalibrationLabel;
  /** 金标判定：确定性断言结果或人工抽检 */
  groundTruthLabel: CalibrationLabel;
  /** judge 连续分（0-1），可选；提供后计算分数相关性 */
  judgeScore?: number;
  /** 金标连续分（0-1），可选 */
  groundTruthScore?: number;
}

export interface ConfusionMatrix {
  /** judge pass & 金标 pass */
  truePositive: number;
  /** judge fail & 金标 fail */
  trueNegative: number;
  /** judge pass & 金标 fail —— judge 虚高（被讨好的主要失效模式） */
  falsePositive: number;
  /** judge fail & 金标 pass —— judge 误杀 */
  falseNegative: number;
}

export interface CalibrationReport {
  total: number;
  confusion: ConfusionMatrix;
  /** 裸一致率 (TP+TN)/total */
  agreementRate: number;
  /** Cohen's Kappa，去除随机一致 */
  cohensKappa: number;
  /** κ 的近似 95% 置信区间下界 */
  kappaLowerBound95: number;
  /** Landis-Koch 解读档位 */
  kappaInterpretation: string;
  /** 虚高率 FP/(FP+TN)：金标为 fail 时 judge 错判 pass 的比例 */
  falsePositiveRate: number;
  /** 误杀率 FN/(FN+TP)：金标为 pass 时 judge 错判 fail 的比例 */
  falseNegativeRate: number;
  /** 分数 Pearson 相关（两侧分数齐备时才有） */
  scoreCorrelation?: number;
  /** 全部分歧 case（judge 与金标不一致），供人工复核 */
  disagreements: CalibrationPair[];
}

export function approximateKappaLowerBound95(kappa: number, pairs: number): number {
  if (pairs < 2) return -1;
  const standardError = Math.sqrt(Math.max(0, 1 - (kappa * kappa)) / (pairs - 1));
  return Math.max(-1, kappa - (1.96 * standardError));
}

/** Landis & Koch (1977) kappa 解读档位 */
function interpretKappa(kappa: number): string {
  if (kappa < 0) return 'poor (worse than chance)';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost perfect';
}

function pearson(xs: number[], ys: number[]): number | undefined {
  const n = xs.length;
  if (n < 2) return undefined;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return undefined; // 无方差，相关性未定义
  return cov / Math.sqrt(vx * vy);
}

export function computeCalibration(pairs: CalibrationPair[]): CalibrationReport {
  const confusion: ConfusionMatrix = {
    truePositive: 0,
    trueNegative: 0,
    falsePositive: 0,
    falseNegative: 0,
  };
  const disagreements: CalibrationPair[] = [];

  for (const p of pairs) {
    const j = p.judgeLabel === 'pass';
    const t = p.groundTruthLabel === 'pass';
    if (j && t) confusion.truePositive++;
    else if (!j && !t) confusion.trueNegative++;
    else if (j && !t) confusion.falsePositive++;
    else confusion.falseNegative++;
    if (p.judgeLabel !== p.groundTruthLabel) disagreements.push(p);
  }

  const total = pairs.length;
  const { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn } = confusion;

  if (total === 0) {
    return {
      total: 0,
      confusion,
      agreementRate: 0,
      cohensKappa: 0,
      kappaLowerBound95: -1,
      kappaInterpretation: interpretKappa(0),
      falsePositiveRate: 0,
      falseNegativeRate: 0,
      disagreements,
    };
  }

  const po = (tp + tn) / total;
  // 随机一致概率：两侧各自 pass/fail 边际概率的乘积之和
  const judgePass = (tp + fp) / total;
  const truthPass = (tp + fn) / total;
  const pe = judgePass * truthPass + (1 - judgePass) * (1 - truthPass);
  // pe===1 表示两侧都恒为同一类，此时若 po===1 视为完全一致，否则无信息→0
  const cohensKappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);

  const falsePositiveRate = fp + tn > 0 ? fp / (fp + tn) : 0;
  const falseNegativeRate = fn + tp > 0 ? fn / (fn + tp) : 0;

  // 分数相关：仅在所有配对两侧分数齐备时计算
  let scoreCorrelation: number | undefined;
  const scored = pairs.filter((p) => typeof p.judgeScore === 'number' && typeof p.groundTruthScore === 'number');
  if (scored.length === pairs.length && scored.length >= 2) {
    scoreCorrelation = pearson(
      scored.map((p) => p.judgeScore as number),
      scored.map((p) => p.groundTruthScore as number),
    );
  }

  return {
    total,
    confusion,
    agreementRate: po,
    cohensKappa,
    kappaLowerBound95: approximateKappaLowerBound95(cohensKappa, total),
    kappaInterpretation: interpretKappa(cohensKappa),
    falsePositiveRate,
    falseNegativeRate,
    scoreCorrelation,
    disagreements,
  };
}

/**
 * 冻结轨迹重复判的方差汇总（N-JEV-EVAL-JUDGE 母单验收⑥，接到 judge-calibration.ts 的 --repeat）。
 * scores 一题多次重复判的数值分（yes=1 / no=0；弃权/unavailable 为 null 不进方差）。
 * 方差 = 总体方差 mean((x-mean)²)；数值分不足 2 次的题 scoreVariance=null（证据不足，不冒充 0）。
 * flips 数相邻两次判决不一致的次数（含 null 与数值之间的切换——弃权↔硬判同样是抖动）。
 */
interface CaseRepeatVariance {
  caseId: string;
  runs: number;
  judgedRuns: number;
  flips: number;
  scoreVariance: number | null;
}

export interface RepeatVarianceSummary {
  cases: CaseRepeatVariance[];
  /** 至少有 2 次数值判决的题数。 */
  varianceCases: number;
  meanVariance: number | null;
  totalRuns: number;
  totalFlips: number;
}

export function summarizeRepeatVariance(
  repeats: Array<{ caseId: string; scores: Array<number | null> }>,
): RepeatVarianceSummary {
  const cases: CaseRepeatVariance[] = repeats.map(({ caseId, scores }) => {
    const numeric = scores.filter((score): score is number => score !== null);
    let flips = 0;
    for (let index = 1; index < scores.length; index += 1) {
      if (scores[index] !== scores[index - 1]) flips += 1;
    }
    let scoreVariance: number | null = null;
    if (numeric.length >= 2) {
      const mean = numeric.reduce((sum, score) => sum + score, 0) / numeric.length;
      scoreVariance = numeric.reduce((sum, score) => sum + (score - mean) ** 2, 0) / numeric.length;
    }
    return { caseId, runs: scores.length, judgedRuns: numeric.length, flips, scoreVariance };
  });
  const withVariance = cases.flatMap((entry) => (entry.scoreVariance === null ? [] : [entry.scoreVariance]));
  return {
    cases,
    varianceCases: withVariance.length,
    meanVariance: withVariance.length > 0
      ? withVariance.reduce((sum, variance) => sum + variance, 0) / withVariance.length
      : null,
    totalRuns: cases.reduce((sum, entry) => sum + entry.runs, 0),
    totalFlips: cases.reduce((sum, entry) => sum + entry.flips, 0),
  };
}

/**
 * 校准记录的判官身份解析（ai-review #2023 Important：Jev 决断的 κ 不许写到 quick 名下，
 * 否则未校准的生成式判官会拿着 Jev 的一致率误过校准门）。
 * - 未开 prescreen：用 quick 生成式身份（缺 quick 配置 ⇒ null）。
 * - 开了 prescreen：全部有效判决都出自 Jev ⇒ Jev 身份；有任何生成式判决混入或零有效判决 ⇒ null
 *   （调用方只落原始报告、不写校准注册表——混合 κ 不给任何一侧背书）。
 */
export interface CalibrationJudgeIdentity {
  judgeId: string;
  promptHash: string;
  endpoint: string;
  judgeModel: string;
}

export function resolveCalibrationJudgeIdentity(input: {
  prescreen: boolean;
  dimension: string;
  quick: { judgeModel: string; promptHash: string; endpoint: string } | null;
  judged: Array<{ judgeModel: string; promptHash: string }>;
  jev: { judgeModel: string; endpoint: string };
}): CalibrationJudgeIdentity | null {
  if (!input.prescreen) {
    if (!input.quick) return null;
    return {
      judgeId: `${input.dimension}@${input.quick.judgeModel}`,
      promptHash: input.quick.promptHash,
      endpoint: input.quick.endpoint,
      judgeModel: input.quick.judgeModel,
    };
  }
  if (input.judged.length === 0) return null;
  if (!input.judged.every((entry) => entry.judgeModel === input.jev.judgeModel)) return null;
  return {
    judgeId: `${input.dimension}@${input.jev.judgeModel}`,
    promptHash: input.judged[0].promptHash,
    endpoint: input.jev.endpoint,
    judgeModel: input.jev.judgeModel,
  };
}
