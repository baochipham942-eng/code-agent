import React, { useEffect, useMemo, useState } from 'react';
import type { EvalCompareArm, EvalRunPanelProbe, EvalRunRequest } from '@shared/contract/evaluation';
import { effectiveArmSignature } from '@shared/contract/evaluation';
import { Button } from '@renderer/components/primitives/Button';
import { Modal } from '@renderer/components/primitives/Modal';
import { Select } from '@renderer/components/primitives/Select';
import { Textarea } from '@renderer/components/primitives/Textarea';
import { Toggle } from '@renderer/components/primitives/Toggle';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { EvalCaseSelectionFields } from './EvalCaseSelectionFields';
import { EVAL_HARNESS_DIMENSIONS, type EvalHarnessDimension } from './evalExperimentDimensions';
import { useRunConfirmation } from './useRunConfirmation';

type BooleanHarnessDimension = Exclude<EvalHarnessDimension, 'toolMode'>;

const BOOLEAN_HARNESS_DIMENSIONS = EVAL_HARNESS_DIMENSIONS.filter(
  (key): key is BooleanHarnessDimension => key !== 'toolMode',
);

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function initialCandidate(baseline: EvalCompareArm): EvalCompareArm {
  return { ...baseline, name: 'candidate', harness: baseline.harness ? { ...baseline.harness, name: 'candidate' } : undefined };
}

export const EvalExperimentWizard: React.FC<{
  open: boolean;
  probe: EvalRunPanelProbe;
  starting: boolean;
  onClose(): void;
  onStart(request: EvalRunRequest): void;
}> = ({ open, probe, starting, onClose, onStart }) => {
  const { t } = useEvaluationI18n();
  const labels = t.evalCenter.experiments;
  const runLabels = t.evalCenter.runPanel;
  const baseline = probe.productionArm;
  const [candidate, setCandidate] = useState<EvalCompareArm>(() => initialCandidate(baseline));
  const [split, setSplit] = useState<NonNullable<EvalRunRequest['split']>>('held-in');
  const [tags, setTags] = useState<string[]>([]);
  const [maxCases, setMaxCases] = useState(probe.splitCounts['held-in']);
  const [repeat, setRepeat] = useState(1);
  useEffect(() => {
    if (open) {
      setCandidate(initialCandidate(baseline));
      setSplit('held-in'); setTags([]); setMaxCases(probe.splitCounts['held-in']); setRepeat(1);
    }
  }, [baseline, open, probe.splitCounts]);
  const same = effectiveArmSignature(candidate, baseline) === effectiveArmSignature(baseline, baseline);
  const estimatedCost = probe.estimatedCostPerCaseUsd * maxCases * 2 * repeat;
  const request = useMemo<EvalRunRequest>(() => ({
    scope: 'full', split, maxCases, repeat,
    ...(tags.length ? { tags } : {}),
    compare: { candidate },
  }), [candidate, maxCases, repeat, split, tags]);
  const confirmation = useRunConfirmation(() => onStart(request));

  const setHarness = (key: BooleanHarnessDimension, value: boolean) => {
    setCandidate((current) => ({
      ...current,
      harness: { name: current.name, ...(current.harness ?? {}), [key]: value },
    }));
    confirmation.reset();
  };
  const toggleSkill = (name: string) => {
    setCandidate((current) => {
      const skills = current.skills ?? [];
      return { ...current, skills: skills.includes(name) ? skills.filter((item) => item !== name) : [...skills, name] };
    });
    confirmation.reset();
  };
  const footer = <div className="flex w-full items-center gap-3 bg-badge-warning px-4 py-3">
    <div className="text-xs text-badge-warning">
      <div>{replace(labels.estimated, { cost: formatUsd(estimatedCost), count: maxCases, k: repeat })}</div>
      {same && <div className="mt-1" data-testid="experiment-same-reason">{labels.sameReason}</div>}
    </div>
    <Button className="ml-auto" variant="ghost" size="sm" onClick={onClose} disabled={starting}>{labels.cancel}</Button>
    <Button size="sm" disabled={same || starting} loading={starting} onClick={confirmation.trigger} data-testid="experiment-run-confirm">
      {starting ? labels.starting : confirmation.confirmArmed ? labels.confirm : labels.launch}
    </Button>
  </div>;

  return <Modal isOpen={open} onClose={onClose} title={labels.wizardTitle} size="full" footer={footer} portal>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="min-w-0 rounded-lg bg-zinc-900 p-4 break-words">
        <h3 className="text-sm font-semibold text-zinc-200">{labels.baseline}</h3><p className="text-xs text-zinc-500">{labels.baselineHint}</p>
        <dl className="mt-3 min-w-0 space-y-2 text-xs text-zinc-400 break-words">
          <div className="min-w-0 break-words">{labels.promptVersion}: {baseline.name}</div>
          <div className="min-w-0 break-words">{labels.model}: {baseline.model}</div>
          <div className="min-w-0 break-words">{labels.provider}: {baseline.provider}</div>
          {EVAL_HARNESS_DIMENSIONS.map((key) => {
            const value = key === 'toolMode'
              ? labels.toolModes[baseline.harness?.toolMode ?? 'all']
              : baseline.harness?.[key] ? labels.enabled : labels.disabled;
            return <div key={key} className="min-w-0 break-words" data-testid={`baseline-harness-${key}`}>{labels.harnessDimensions[key]}: {value}</div>;
          })}
          <div className="min-w-0 break-words">{labels.skill}: {(baseline.skills ?? []).join(', ') || '—'}</div>
          <div className="min-w-0 break-words">{labels.memory}: {baseline.memory?.longTerm ? labels.enabled : labels.disabled}</div>
        </dl>
      </section>
      <section className="min-w-0 rounded-lg bg-zinc-900 p-4 break-words">
        <h3 className="text-sm font-semibold text-zinc-200">{labels.candidate}</h3>
        <label className="mt-3 block text-xs text-zinc-400">{labels.promptVersion}
          <Textarea minRows={3} value={candidate.systemPrompt ?? ''} placeholder={baseline.name} onChange={(event) => { setCandidate({ ...candidate, systemPrompt: event.target.value || undefined }); confirmation.reset(); }} />
        </label>
        <label className="mt-3 block text-xs text-zinc-400">{labels.model}<input className="mt-1 w-full rounded-lg bg-zinc-700 px-3 py-2 text-zinc-200" value={candidate.model ?? ''} onChange={(event) => { setCandidate({ ...candidate, model: event.target.value }); confirmation.reset(); }} /></label>
        <label className="mt-3 block text-xs text-zinc-400">{labels.provider}<Select selectSize="sm" value={candidate.provider ?? ''} options={[{ value: probe.provider, label: probe.provider }]} onChange={(event) => { setCandidate({ ...candidate, provider: event.target.value }); confirmation.reset(); }} /></label>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {BOOLEAN_HARNESS_DIMENSIONS.map((key) => <label key={key} className="flex min-w-0 items-center justify-between gap-2 rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400 break-words"><span className="min-w-0 break-words">{labels.harnessDimensions[key]}</span><Toggle checked={candidate.harness?.[key] ?? false} onChange={(value) => setHarness(key, value)} aria-label={labels.harnessDimensions[key]} /></label>)}
          <label className="flex min-w-0 items-center justify-between gap-2 rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400 break-words"><span className="min-w-0 break-words">{labels.harnessDimensions.toolMode}</span><Select fullWidth={false} selectSize="sm" value={candidate.harness?.toolMode ?? 'all'} options={[{ value: 'all', label: labels.toolModes.all }, { value: 'deferred', label: labels.toolModes.deferred }]} onChange={(event) => { setCandidate({ ...candidate, harness: { name: candidate.name, ...(candidate.harness ?? {}), toolMode: event.target.value as 'all' | 'deferred' } }); confirmation.reset(); }} /></label>
          <label className="flex items-center justify-between rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400">{labels.memory}<Toggle checked={candidate.memory?.longTerm ?? false} onChange={(value) => { setCandidate({ ...candidate, memory: { ...candidate.memory, longTerm: value } }); confirmation.reset(); }} /></label>
        </div>
        <label className="mt-3 block text-xs text-zinc-400">{labels.reasoning}<Select selectSize="sm" value={candidate.reasoningEffort ?? ''} options={[{ value: '', label: labels.same }, ...['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value }))]} onChange={(event) => { setCandidate({ ...candidate, reasoningEffort: (event.target.value || undefined) as EvalCompareArm['reasoningEffort'] }); confirmation.reset(); }} /></label>
        <div className="mt-3 text-xs text-zinc-400">{labels.skill}<div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto">{probe.skills.map((name) => <button type="button" key={name} aria-pressed={(candidate.skills ?? []).includes(name)} onClick={() => toggleSkill(name)} className={`rounded-full px-2 py-1 ${(candidate.skills ?? []).includes(name) ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500'}`}>{name}</button>)}</div><p className="mt-1 text-[10px] text-zinc-500">{labels.chooseSkill}</p></div>
      </section>
    </div>
    <div className="mt-4 grid gap-3 rounded-lg bg-zinc-900 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
      <EvalCaseSelectionFields
        probe={probe}
        split={split as 'held-in' | 'held-out' | 'safety'}
        tags={tags}
        maxCases={maxCases}
        labels={runLabels}
        onSplit={(next) => { setSplit(next); setMaxCases(probe.splitCounts[next]); confirmation.reset(); }}
        onToggleTag={(tag) => { setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]); confirmation.reset(); }}
        onMaxCases={(next) => { setMaxCases(next); confirmation.reset(); }}
      />
      <section className="min-w-0">
        <label className="text-xs text-zinc-400">{labels.repeat}<input type="number" min={1} max={10} className="mt-1 w-full rounded-lg bg-zinc-700 px-3 py-2 text-zinc-200" value={repeat} onChange={(event) => { setRepeat(Math.max(1, Math.min(10, Number(event.target.value) || 1))); confirmation.reset(); }} /></label>
      </section>
    </div>
  </Modal>;
};
