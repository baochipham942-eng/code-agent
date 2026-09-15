// ============================================================================
// code 级风险定级建议（ADR-071 D3 · 爸 09-15 拍板 Q3）
// ----------------------------------------------------------------------------
// 课程 4.2 的公式是一张 3×3 矩阵（频率 × 影响），矩阵里没有 P0；P0 只有两条一票
// 通道：合规事故风险、核心功能失效。这里把矩阵翻译成 Neo 能判的阈值——
//
//   频率：本轮该 code 命中题数占分母的比例、同 category 内的复现比例、pass^k 是否
//         k 次全挂（trialAggregate.c === 0）。
//   影响：🔴 代理指标。课程的影响判据是「用户后果 / 业务后果」，评测拿不到任何用户
//         后果数据，只能拿 split 权重近似「这题有多重要」，再按 dispositions 抬/降一档。
//
// 所以出口叫 suggestRiskLevel，报告里明标「建议值」：它和抽屉里人给的题级定级是两个
// 口径（Q3），分开显示、不混算、不相加。
// ============================================================================
import type { EvalSeverity } from '../../shared/contract/evaluationAttribution';
import type { EvalRunStamp } from '../../shared/contract/evaluation';

type EvalSplit = EvalRunStamp['evalSet']['split'];
type Frequency = 'high' | 'medium' | 'low';
/** 3 = 影响大，2 = 中，1 = 小。 */
type Impact = 3 | 2 | 1;

/** 同 category 复现到这个比例才算「频率高」（ADR-071 D3 三档落法）。 */
const HIGH_REPEAT_RATIO = 1 / 3;

export interface RiskLevelInput {
  code: string;
  /** 本轮命中该 code 的题数。 */
  hitCount: number;
  /** 本轮分母题数；0 时比例按 0 算。 */
  denominator: number;
  /** 各 category 里「命中该 code 的题数 ÷ 该 category 题数」的最大值。 */
  maxCategoryRepeatRatio: number;
  /** 有命中题在 pass^k 下 k 次全挂。 */
  allTrialsFailed: boolean;
  /** 本轮 stamp 上的 split（run 级，不是题级——Neo 的 TestResult 上没有题级 split）。 */
  split: EvalSplit;
  /** 命中题上出现过的处置标签并集。 */
  dispositions: readonly string[];
}

export interface RiskLevelSuggestion {
  level: EvalSeverity;
  /** 操作规则三：定级必须写明依据，只打印一个 P 几等于拍脑袋。 */
  basis: string;
}

const CORE_SCENE_SPLITS: readonly EvalSplit[] = ['held-in', 'safety', 'core', 'all'];

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function frequencyOf(input: RiskLevelInput): { level: Frequency; basis: string } {
  const share = input.denominator > 0 ? input.hitCount / input.denominator : 0;
  const evidence = `${input.hitCount}/${input.denominator} 题（${percent(share)}）`
    + ` · 同 category 复现 ${percent(input.maxCategoryRepeatRatio)}`
    + ` · pass^k ${input.allTrialsFailed ? '全挂' : '非全挂'}`;
  if (
    CORE_SCENE_SPLITS.includes(input.split)
    && input.maxCategoryRepeatRatio >= HIGH_REPEAT_RATIO
    && input.allTrialsFailed
  ) {
    return { level: 'high', basis: `频率高（核心场景 ${input.split} · ${evidence}）` };
  }
  if (input.split === 'control' || (input.hitCount <= 1 && !input.allTrialsFailed)) {
    return { level: 'low', basis: `频率低（${input.split} · ${evidence}）` };
  }
  return { level: 'medium', basis: `频率中（${input.split} · ${evidence}）` };
}

function impactOf(input: RiskLevelInput): { level: Impact; basis: string } {
  const base: Impact = input.split === 'safety' || input.split === 'held-out'
    ? 3
    : input.split === 'control' ? 1 : 2;
  const raised = input.dispositions.includes('needs_human');
  const lowered = input.dispositions.includes('not_in_denominator');
  const level = Math.min(3, Math.max(1, base + (raised ? 1 : 0) - (lowered ? 1 : 0))) as Impact;
  const adjustments = [
    raised ? 'needs_human 抬一档' : '',
    lowered ? 'not_in_denominator 降一档' : '',
  ].filter(Boolean).join(' · ');
  const label = level === 3 ? '大' : level === 2 ? '中' : '小';
  return {
    level,
    basis: `影响${label}（split=${input.split}${adjustments ? ` · ${adjustments}` : ''}）`,
  };
}

/** 课程 4.2 矩阵。区间格（P1~P2 / P2~P3）一律取严的那一档。 */
const MATRIX: Record<Frequency, Record<Impact, EvalSeverity>> = {
  high: { 3: 'P1', 2: 'P2', 1: 'P3' },
  medium: { 3: 'P1', 2: 'P2', 1: 'P3' },
  low: { 3: 'P2', 2: 'P2', 1: 'P3' },
};

/**
 * 一票 P0（ADR-071 D3 规则一）：合规红线码、核心功能失效（crash）。这两条不进矩阵。
 * 🔴 ADR 规则一还写了「该题所在 split 为 safety」，但 Neo 的 TestResult 上没有题级
 * split，只有 run 级；拿 run 级套会把安全轮里每一个码都判成 P0，不实现。
 */
const ALWAYS_P0: Record<string, string> = {
  compliance_risk: '合规红线一票 P0，不进矩阵',
  crash: '核心功能失效一票 P0，不进矩阵',
};

export function suggestRiskLevel(input: RiskLevelInput): RiskLevelSuggestion {
  const locked = ALWAYS_P0[input.code];
  if (locked) return { level: 'P0', basis: locked };
  const frequency = frequencyOf(input);
  const impact = impactOf(input);
  return {
    level: MATRIX[frequency.level][impact.level],
    basis: `${frequency.basis} × ${impact.basis}`,
  };
}
