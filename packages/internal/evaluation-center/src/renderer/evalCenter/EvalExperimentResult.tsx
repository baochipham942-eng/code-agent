import React, { useMemo, useState } from 'react';
import { ArrowLeft, Copy, ThumbsDown, ThumbsUp } from 'lucide-react';
import { resolveEffectiveEvalCompareArm, type EvalExperimentDetail } from '@shared/contract/evaluation';
import { Button } from '@renderer/components/primitives/Button';
import { getEvalStatusLabel } from '../i18n/evalStatusLabels';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { EVAL_HARNESS_DIMENSIONS } from './evalExperimentDimensions';
import {
  failingSafetyCount,
  getExperimentCompareConfig,
  getExperimentCompareSummary,
  getExperimentCost,
  stateClasses,
} from './evalExperimentPresentation';

type PairFilter = 'all' | 'candidate' | 'baseline' | 'tie' | 'excluded';

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? '—' : `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ') || '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export const EvalExperimentResult: React.FC<{
  detail: EvalExperimentDetail;
  onBack(): void;
}> = ({ detail, onBack }) => {
  const { t } = useEvaluationI18n();
  const labels = t.evalCenter.experiments;
  const statusLabels = t.evalCenter.caseDrawer.status;
  const [filter, setFilter] = useState<PairFilter>('all');
  const compare = getExperimentCompareSummary(detail.experiment);
  const config = getExperimentCompareConfig(detail.experiment);
  const verdict = compare?.shipGate;
  const dimensions = useMemo(() => {
    if (!config) return [];
    const baseline = resolveEffectiveEvalCompareArm(config.baseline, config.baseline);
    const candidate = resolveEffectiveEvalCompareArm(config.candidate, config.baseline);
    const formatHarnessValue = (arm: typeof baseline, key: (typeof EVAL_HARNESS_DIMENSIONS)[number]) => {
      if (key === 'toolMode') return labels.toolModes[arm.harness?.toolMode ?? 'all'];
      return arm.harness?.[key] ? labels.enabled : labels.disabled;
    };
    const values = [
      [labels.promptVersion, config.baseline.name, config.candidate.systemPrompt ? config.candidate.name : config.baseline.name],
      [labels.model, baseline.model, candidate.model], [labels.provider, baseline.provider, candidate.provider],
      ...EVAL_HARNESS_DIMENSIONS.map((key) => [
        labels.harnessDimensions[key],
        formatHarnessValue(baseline, key),
        formatHarnessValue(candidate, key),
      ] as const),
      [labels.skill, baseline.skills, candidate.skills],
      [labels.memory, baseline.memory.longTerm ? labels.enabled : labels.disabled, candidate.memory.longTerm ? labels.enabled : labels.disabled],
      [labels.reasoning, baseline.reasoningEffort, candidate.reasoningEffort],
    ] as const;
    return values.map(([label, left, right]) => {
      const before = displayValue(left); const after = displayValue(right);
      return `${label}: ${before === after ? labels.same : `${before} → ${after}`}`;
    });
  }, [config, labels]);
  const rows = useMemo(() => detail.cases.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'excluded') return Boolean(item.data?.excludedReason);
    if (item.data?.excludedReason) return false;
    return item.data?.winner === filter;
  }), [detail.cases, filter]);

  if (!verdict || !compare) {
    return (
      <div className="p-4">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />{labels.back}</Button>
        <div className="mt-4 rounded-lg bg-zinc-900 p-4 text-sm text-zinc-400">{labels.noPairs}</div>
      </div>
    );
  }

  const failCount = failingSafetyCount(verdict);
  const notMeasured = verdict.hardGate.items.filter((item) => item.status === 'not_measured').map((item) => item.key);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 p-4" data-testid="eval-experiment-result">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />{labels.back}</Button>
      {failCount > 0 && (
        <div className="mt-3 rounded-lg bg-badge-danger px-4 py-2 text-sm text-badge-danger" role="alert">
          {replace(labels.safetyLine, { n: failCount })}
        </div>
      )}
      <div className={`mt-3 rounded-xl border p-5 ${stateClasses(verdict.state)}`} data-testid={`experiment-verdict-${verdict.state}`}>
        <div className="text-lg font-semibold">{labels.states[verdict.state]}</div>
        {verdict.state === 'non_inferior' && <div className="mt-1 text-xs">Δ {verdict.delta}pp</div>}
        {verdict.state === 'insufficient' && <div className="mt-1 text-xs">{labels.insufficientHint}</div>}
      </div>

      <div className="mt-3 grid gap-2 rounded-lg bg-zinc-900 p-3 text-xs text-zinc-400 md:grid-cols-2">
        <div><span className="text-zinc-500">{labels.diff}：</span>{dimensions.join(' · ') || labels.same}</div>
        <div>{replace(labels.metadata, {
          count: compare.totalCases,
          excluded: compare.excludedPairs,
          cost: formatUsd(getExperimentCost(detail.experiment)),
        })}</div>
      </div>
      <div className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400">{labels.blindHint}</div>

      <div className="mt-3 flex flex-wrap gap-2" aria-label="pair filters">
        {(Object.keys(labels.filters) as PairFilter[]).map((key) => (
          <Button key={key} variant={filter === key ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter(key)} data-testid={`experiment-filter-${key}`}>
            {key === 'candidate' && <ThumbsUp className="mr-1 h-3.5 w-3.5" />}
            {key === 'baseline' && <ThumbsDown className="mr-1 h-3.5 w-3.5" />}
            {labels.filters[key]}
          </Button>
        ))}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg bg-zinc-900">
        <table className="w-full text-left text-xs">
          <thead className="text-zinc-500"><tr>
            <th className="px-3 py-2">{labels.columns.caseId}</th><th className="px-3 py-2">{labels.columns.a}</th>
            <th className="px-3 py-2">{labels.columns.b}</th><th className="px-3 py-2">{labels.columns.winner}</th>
            <th className="px-3 py-2">{labels.columns.skills}</th>
          </tr></thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((item) => {
              const assignment = item.data?.assignment;
              const winner = item.data?.excludedReason ? labels.excluded
                : item.data?.winner === 'candidate' ? labels.candidateName
                  : item.data?.winner === 'baseline' ? labels.baselineName : labels.tie;
              const activations = item.data?.skillActivations;
              const activationsA = assignment?.A === 'candidate' ? activations?.candidate : activations?.baseline;
              const activationsB = assignment?.B === 'candidate' ? activations?.candidate : activations?.baseline;
              return <tr key={item.caseId} data-testid={`experiment-pair-${item.caseId}`}>
                <td className="px-3 py-2 font-mono text-zinc-300">{item.caseId}</td>
                <td className="px-3 py-2 text-zinc-300">{item.data?.statusA ? getEvalStatusLabel(item.data.statusA, statusLabels) : '—'}<div className="text-[10px] text-zinc-500">A={assignment?.A === 'candidate' ? labels.candidateName : labels.baselineName}</div></td>
                <td className="px-3 py-2 text-zinc-300">{item.data?.statusB ? getEvalStatusLabel(item.data.statusB, statusLabels) : '—'}<div className="text-[10px] text-zinc-500">B={assignment?.B === 'candidate' ? labels.candidateName : labels.baselineName}</div></td>
                <td className="px-3 py-2 text-zinc-300">{winner}</td>
                <td className="px-3 py-2 text-zinc-400">{activationsA ?? 0}/{activationsB ?? 0}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <details className="mt-4 rounded-lg bg-zinc-900 p-3 text-xs text-zinc-400" data-testid="experiment-technical-details">
        <summary className="cursor-pointer font-medium text-zinc-300">{labels.technical}</summary>
        <dl className="mt-3 grid gap-2 md:grid-cols-2">
          <div>{labels.pValue}: {verdict.pValue}</div><div>{labels.decisivePairs}: {verdict.decisivePairs}</div>
          <div>{labels.ciLowerBound}: {verdict.ciLowerBound}</div><div>{labels.delta}: {verdict.delta}</div>
          <div>{labels.nMin}: {verdict.nMin}</div><div>{labels.calibre}: k={verdict.calibre.k} · v{verdict.calibre.aggregationRuleVersion} · {verdict.calibre.promptVersion}</div>
          <div>{labels.reasons}: {verdict.reasons.join(' · ') || '—'}</div><div>{labels.unmeasured}: {notMeasured.join(', ') || '—'}</div>
          <div className="flex items-center gap-2">{labels.experimentId}: <code>{detail.experiment.id}</code>
            <button type="button" aria-label={labels.copy} onClick={() => void navigator.clipboard?.writeText(detail.experiment.id)}><Copy className="h-3.5 w-3.5" /></button>
          </div>
          <div>{labels.reference}: {detail.cases.map((item) => item.data?.referenceWinner).filter(Boolean).join(', ') || '—'}</div>
        </dl>
      </details>
    </div>
  );
};
