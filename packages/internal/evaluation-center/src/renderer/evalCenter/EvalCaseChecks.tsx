import React, { useMemo } from 'react';
import type {
  AiReviewDimension,
  EvalExperimentCaseDetail,
} from '@shared/contract/evaluation';
import type { EvalCaseDrawerLabels } from '../i18n/evalCaseDrawer';

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

interface EvalCaseChecksProps {
  detail: EvalExperimentCaseDetail;
  labels: EvalCaseDrawerLabels;
  aiDimensionLabels: Record<AiReviewDimension, string>;
  excluded: boolean;
  excludedStatusLabel: string;
}

export const EvalCaseChecks: React.FC<EvalCaseChecksProps> = ({
  detail,
  labels,
  aiDimensionLabels,
  excluded,
  excludedStatusLabel,
}) => {
  const catalog = useMemo(
    () => new Map(detail.assertionCatalog.map((item) => [item.type, item.summary])),
    [detail.assertionCatalog],
  );

  if (excluded) {
    return (
      <div className="space-y-2 text-xs leading-5 text-zinc-400" data-testid="eval-case-excluded-checks">
        <p className="text-badge-warning">{fill(labels.excludedExplanation, { status: excludedStatusLabel })}</p>
        {detail.failureReason && <p>{fill(labels.excludedFailure, { reason: detail.failureReason })}</p>}
      </div>
    );
  }

  if (!detail.evidence) {
    return <p className="text-xs text-zinc-500">{labels.noProcessEvidence}</p>;
  }

  const checks = detail.evidence.checks;
  const passed = checks.filter((check) => check.passed).length;
  const failed = checks.length - passed;
  const judgement = failed === 0 && detail.status === 'passed'
    ? labels.judgedPassed
    : labels.judgedFailed;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[500px] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wide text-zinc-600">
            <tr>
              <th className="w-8 py-1 font-medium" aria-label={labels.checks} />
              <th className="py-1 font-medium">{labels.checkName}</th>
              <th className="py-1 font-medium">{labels.expected}</th>
              <th className="py-1 font-medium">{labels.actual}</th>
              <th className="py-1 text-right font-medium">{labels.scoreColumn}</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check, index) => (
              <tr key={`${check.type}-${index}`} className="border-t border-zinc-800 align-top">
                <td className={check.passed ? 'py-2 text-badge-success' : 'py-2 text-badge-danger'}>
                  {check.passed ? '✓' : '✕'}
                </td>
                <td className="py-2 pr-2 text-zinc-300">
                  <div>{catalog.get(check.type) ?? check.type}</div>
                  {check.details && <div className="mt-1 text-[10px] text-zinc-600">{check.details}</div>}
                </td>
                <td className="max-w-40 break-words py-2 pr-2 text-zinc-500">{check.expected}</td>
                <td className="max-w-40 break-words py-2 pr-2 text-zinc-400">{check.actual}</td>
                <td className="py-2 text-right text-[10px] text-zinc-600">
                  {fill(labels.score, { score: check.passed ? 1 : 0 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-md bg-[var(--bg-hover)] px-3 py-2 text-xs font-medium text-zinc-300" data-testid="eval-case-check-summary">
        {fill(labels.checkSummary, { total: checks.length, passed, failed, judgement })}
      </div>
      {detail.aiReview && Object.keys(detail.aiReview).length > 0 && (
        <div className="rounded-md bg-[var(--bg-hover)] px-3 py-2 text-xs">
          <div className="font-medium text-zinc-300">{labels.aiReview} <span className="font-normal text-zinc-600">({labels.aiReviewNote})</span></div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {Object.entries(detail.aiReview).map(([dimension, verdict]) => verdict && (
              <div key={dimension} className="text-zinc-500">
                <span>{aiDimensionLabels[dimension as AiReviewDimension] ?? dimension}</span>
                <span className="ml-2 text-zinc-300">{labels.verdict[verdict.verdict]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
