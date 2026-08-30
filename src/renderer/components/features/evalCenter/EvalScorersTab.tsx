import React, { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Scale, UserRound } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AiReviewDimension, EvalScorersOverview } from '@shared/contract/evaluation';
import { useI18n } from '../../../hooks/useI18n';
import { invokeEvaluation } from '../../../services/evaluationRunIpc';
import { Badge } from '../../primitives/Badge';
import { Button } from '../../primitives/Button';

const FIRST_FOLD_ASSERTIONS = 7;

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export const EvalScorersTab: React.FC = () => {
  const { t } = useI18n();
  const labels = t.evalCenter.scorers;
  const [overview, setOverview] = useState<EvalScorersOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    void invokeEvaluation(IPC_CHANNELS.EVALUATION_SCORERS_OVERVIEW)
      .then((value) => {
        if (!value || !Array.isArray(value.assertions)) throw new Error('invalid scorer overview');
        setOverview(value);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <div className="p-6 text-sm text-zinc-500">{labels.loadFailed}</div>;
  if (!overview) return <div className="p-6 text-sm text-zinc-500">{labels.loading}</div>;

  const foldedCount = Math.max(0, overview.assertions.length - FIRST_FOLD_ASSERTIONS);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 p-4" data-testid="eval-scorers-tab">
      <div className="mx-auto max-w-5xl space-y-4">
        <section className="rounded-xl bg-zinc-900 p-4 shadow-sm">
          <div className="mb-3 flex items-start gap-2">
            <ClipboardCheck className="mt-0.5 h-4 w-4 text-zinc-400" />
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">{labels.sectionAssertions}</h2>
              <p className="mt-1 text-xs text-zinc-500">{labels.assertionsSubtitle}</p>
            </div>
          </div>
          <div className="divide-y divide-zinc-800" data-testid="expectation-catalog">
            {overview.assertions.map((assertion, index) => (
              <div
                key={assertion.type}
                hidden={!expanded && index >= FIRST_FOLD_ASSERTIONS}
                className="flex items-center gap-3 py-2 text-xs"
                data-expectation-type={assertion.type}
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-badge-success" />
                <code className="w-52 text-zinc-300">{assertion.type}</code>
                <span className="text-zinc-500">{assertion.summary}</span>
              </div>
            ))}
          </div>
          {foldedCount > 0 && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setExpanded((value) => !value)}>
              {expanded ? labels.collapse : replace(labels.collapsed, { n: foldedCount })}
            </Button>
          )}
        </section>

        <section className="rounded-xl bg-zinc-900 p-4 shadow-sm">
          <div className="mb-3 flex items-start gap-2">
            <Scale className="mt-0.5 h-4 w-4 text-zinc-400" />
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">{labels.sectionAiReview}</h2>
              <p className="mt-1 text-xs text-zinc-500">{labels.aiReviewSubtitle}</p>
            </div>
          </div>
          <div className="divide-y divide-zinc-800">
            {overview.aiReview.map(({ dim, calibration, requiresExpectation }) => {
              const calibrated = calibration.state === 'calibrated';
              const dimensionLabel = labels.dimensions[dim as AiReviewDimension];
              const status = calibrated
                ? replace(labels.calibrated, {
                  kappa: calibration.kappa?.toFixed(2) ?? '—',
                  pairs: calibration.pairs ?? 0,
                })
                : calibration.reason ? labels.reasons[calibration.reason] : labels.uncalibrated;
              return (
                <div key={dim} className="flex items-center gap-3 py-3 text-xs" data-testid={`ai-review-${dim}`}>
                  <span className="min-w-48 text-zinc-200">{dimensionLabel}</span>
                  {requiresExpectation && <span className="text-zinc-500">{labels.needsExpectation}</span>}
                  <Badge
                    className={`ml-auto ${calibrated ? 'border-badge-success text-badge-success' : 'border-badge-warning text-badge-warning'}`}
                    dot={calibrated ? 'bg-mark-success' : 'bg-mark-warning'}
                  >
                    {calibrated ? status : `${labels.uncalibrated} · ${status}`}
                    {calibration.goldSource === 'deterministic_shadow' ? labels.shadowGold : ''}
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl bg-zinc-900 p-4 shadow-sm">
          <div className="flex items-center gap-3 text-xs">
            <UserRound className="h-4 w-4 text-zinc-400" />
            <span className="font-semibold text-zinc-100">{labels.sectionHuman}</span>
            <span className="text-zinc-500">{labels.humanReview}</span>
          </div>
        </section>

        <p className="px-1 text-xs text-zinc-500">
          {labels.judgeRule} · {replace(labels.currentJudge, { model: `${overview.judge.provider}/${overview.judge.model}` })}
        </p>
      </div>
    </div>
  );
};
