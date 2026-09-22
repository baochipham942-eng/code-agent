// ============================================================================
// judge-calibration.ts 的纯函数层（脚本专用——不是生产运行时代码，放 scripts/lib 而非
// src/host，否则 knip 生产棘轮会把「只被 scripts/tests 消费的 src 导出」判成 dead export，
// 见 PR#2023 CI smoke。单测在 tests/unit/testing/judgeCalibration.test.ts。
// ============================================================================

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
