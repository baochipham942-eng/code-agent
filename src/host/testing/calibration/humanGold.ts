// ============================================================================
// 人标金标解析 — 把「进金标集」的人工评审变成 judge 校准的真值（N-EVAL-JUDGE-HUMANGOLD）
// ----------------------------------------------------------------------------
// 课程口径：金标集管「对不对」，Kappa 管「稳不稳」；金标结论必须无争议——
// 有争议的题不配进金标集，进边界案例集。所以：每个 reviewer 只取最新一条，
// 多人对同一题同一维判得不一样 ⇒ 整题跳过并点名，不做多数表决。
// ============================================================================
import type { AiReviewDimension } from '../../../shared/contract/evaluation';
import type { AnnotationRow } from '../../services/core/repositories/AnnotationRepository';
import type { CalibrationLabel } from './judgeCalibration';

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
    const verdicts = new Set([...byReviewer.values()].map((row) => verdictOf(row, dimension)).filter((v): v is 'yes' | 'no' => v !== null));
    if (verdicts.size === 0) unlabeled.push(caseId);
    else if (verdicts.size > 1) contested.push(caseId);
    else labels.set(caseId, verdicts.has('yes') ? 'pass' : 'fail');
  }
  return { labels, contested: contested.sort(), unlabeled: unlabeled.sort() };
}
