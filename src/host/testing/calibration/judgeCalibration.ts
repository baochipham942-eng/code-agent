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
    kappaInterpretation: interpretKappa(cohensKappa),
    falsePositiveRate,
    falseNegativeRate,
    scoreCorrelation,
    disagreements,
  };
}
