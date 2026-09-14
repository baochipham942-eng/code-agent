// ============================================================================
// 人标金标解析 — 把「进金标集」的人工评审变成 judge 校准的真值（N-EVAL-JUDGE-HUMANGOLD）
// 住在 scripts/lib：唯一消费方是 scripts/judge-calibration.ts，放 src/ 会被生产可达性棘轮判「断电文件」。
// ----------------------------------------------------------------------------
// 课程口径：金标集管「对不对」，Kappa 管「稳不稳」；金标结论必须无争议——
// 有争议的题不配进金标集，进边界案例集。所以：每个 reviewer 只取最新一条，
// 多人对同一题同一维判得不一样 ⇒ 整题跳过并点名，不做多数表决。
// 入参是这轮实验的**全部**人工判定：金标资格看每个 reviewer 最新那条有没有勾 gold，
// 于是「先勾后取消」自然撤销（取消 = 追加一条没勾 gold 的新行）。
// ============================================================================
import type { AiReviewDimension } from '../../src/shared/contract/evaluation';
import type { AnnotationRow } from '../../src/host/services/core/repositories/AnnotationRepository';
import type { CalibrationLabel } from '../../src/host/testing/calibration/judgeCalibration';

export interface HumanGoldResolution {
  /** caseId → 金标标签 */
  labels: Map<string, CalibrationLabel>;
  /** 多人分歧、跳过的题 */
  contested: string[];
  /** 勾了金标但没标本维的题 */
  unlabeled: string[];
}

function verdictOf(row: AnnotationRow, dimension: AiReviewDimension): 'yes' | 'no' | null {
  try {
    const dims = JSON.parse(row.dims_json) as Record<string, unknown>;
    const value = dims[dimension];
    return value === 'yes' || value === 'no' ? value : null;
  } catch {
    return null;
  }
}

export function resolveHumanGoldLabels(rows: AnnotationRow[], dimension: AiReviewDimension): HumanGoldResolution {
  const byCase = new Map<string, Map<string, AnnotationRow>>();
  for (const row of [...rows].sort((a, b) => b.created_at - a.created_at)) {
    const byReviewer = byCase.get(row.case_id) ?? new Map<string, AnnotationRow>();
    if (!byReviewer.has(row.reviewer_id)) byReviewer.set(row.reviewer_id, row);
    byCase.set(row.case_id, byReviewer);
  }
  const labels = new Map<string, CalibrationLabel>();
  const contested: string[] = [];
  const unlabeled: string[] = [];
  for (const [caseId, byReviewer] of byCase) {
    const goldRows = [...byReviewer.values()].filter((row) => row.calibration_split === 'gold');
    if (goldRows.length === 0) continue; // 没人（或已全部取消）把这题标进金标
    const verdicts = new Set(goldRows.map((row) => verdictOf(row, dimension)).filter((v): v is 'yes' | 'no' => v !== null));
    if (verdicts.size === 0) unlabeled.push(caseId);
    else if (verdicts.size > 1) contested.push(caseId);
    else labels.set(caseId, verdicts.has('yes') ? 'pass' : 'fail');
  }
  return { labels, contested: contested.sort(), unlabeled: unlabeled.sort() };
}
