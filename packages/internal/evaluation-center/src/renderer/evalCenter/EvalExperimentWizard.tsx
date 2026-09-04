import React, { useEffect, useMemo, useState } from 'react';
import type { EvalCompareArm, EvalRunPanelProbe, EvalRunRequest } from '@shared/contract/evaluation';
import { effectiveArmSignature, resolveEffectiveEvalCompareArm } from '@shared/contract/evaluation';
import { SPAWN_GUARD } from '@shared/constants/agent';
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

  // 「本轮配置一行」：把 allowSwarm + spawnMaxDepth 折成一句人话，跟报告里的
  // describeEvalCompareDiff 同口径（不扇出 / 最深 N 层）。
  const describeOrchestration = (arm: EvalCompareArm, base: EvalCompareArm): string => {
    const { orchestration } = resolveEffectiveEvalCompareArm(arm, base);
    const depth = orchestration.spawnMaxDepth === null
      ? replace(labels.depthDefault, { n: SPAWN_GUARD.DEFAULT_SPAWN_DEPTH })
      : orchestration.spawnMaxDepth === 0
        ? labels.depthNone
        : replace(labels.depthN, { n: orchestration.spawnMaxDepth });
    return `${orchestration.allowSwarm ? labels.swarmOn : labels.swarmOff} · ${depth}`;
  };
  const baselineOrchestrationText = describeOrchestration(baseline, baseline);
  const candidateOrchestrationText = describeOrchestration(candidate, baseline);

  const setAllowSwarm = (value: boolean) => {
    setCandidate((current) => ({ ...current, orchestration: { ...current.orchestration, allowSwarm: value } }));
    confirmation.reset();
  };
  const setSpawnMaxDepth = (raw: string) => {
    // 空串 = 不覆盖（跟随生产默认）；其余 clamp 到 [0, 硬上限]，与 host 校验同界。
    const next = raw.trim() === ''
      ? undefined
      : Math.max(0, Math.min(SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH, Math.floor(Number(raw) || 0)));
    setCandidate((current) => {
      const orchestration = { ...current.orchestration };
      if (next === undefined) delete orchestration.spawnMaxDepth;
      else orchestration.spawnMaxDepth = next;
      return {
        ...current,
        orchestration: Object.keys(orchestration).length > 0 ? orchestration : undefined,
      };
    });
    confirmation.reset();
  };

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
  // 外层 Modal footer 自带 px-6 py-4；这里再套一层 px-4 py-3 会把两行费用文字挤到按钮身上
  // （2026-09-04 爸真机报「底部费用条与按钮挤压」）。费用块占剩余宽并可换行，按钮永不被压缩。
  const footer = <div className="flex w-full items-center gap-3 rounded-lg bg-badge-warning px-3 py-2">
    <div className="min-w-0 flex-1 text-xs text-badge-warning">
      <div>{replace(labels.estimated, { cost: formatUsd(estimatedCost), count: maxCases, k: repeat })}</div>
      {same && <div className="mt-1" data-testid="experiment-same-reason">{labels.sameReason}</div>}
    </div>
    <Button className="shrink-0" variant="ghost" size="sm" onClick={onClose} disabled={starting}>{labels.cancel}</Button>
    <Button className="shrink-0" size="sm" disabled={same || starting} loading={starting} onClick={confirmation.trigger} data-testid="experiment-run-confirm">
      {starting ? labels.starting : confirmation.confirmArmed ? labels.confirm : labels.launch}
    </Button>
  </div>;

  return <Modal isOpen={open} onClose={onClose} title={labels.wizardTitle} size="full" footer={footer} portal>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* 左栏纵向堆两块：对照组本身只有一列只读字段（约占半屏），右边实验组表单长得多——
          题目选择原先横在两栏下方，把整个弹窗撑到 1040px（视口只给 654px），费用条却已经在说
          「76 题 × 2 组」，而用户要滚到折叠线以下才看得到这 76 是哪来的、怎么改
          （2026-09-04 爸真机报「两栏内容超出视口」）。搬进左栏空白后两栏高度拉平。 */}
      <div className="flex min-w-0 flex-col gap-4">
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
          <div className="min-w-0 break-words" data-testid="baseline-orchestration">{labels.orchestration}: {baselineOrchestrationText}</div>
        </dl>
      </section>
      <section className="min-w-0 rounded-lg bg-zinc-900 p-4">
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
        <label className="mt-4 block text-xs text-zinc-400">{labels.repeat}<input type="number" min={1} max={10} className="mt-1 w-full rounded-lg bg-zinc-700 px-3 py-2 text-zinc-200" value={repeat} onChange={(event) => { setRepeat(Math.max(1, Math.min(10, Number(event.target.value) || 1))); confirmation.reset(); }} /></label>
      </section>
      </div>
      <section className="min-w-0 rounded-lg bg-zinc-900 p-4 break-words">
        <h3 className="text-sm font-semibold text-zinc-200">{labels.candidate}</h3>
        <label className="mt-3 block text-xs text-zinc-400">{labels.promptVersion}
          <Textarea minRows={3} value={candidate.systemPrompt ?? ''} placeholder={baseline.name} onChange={(event) => { setCandidate({ ...candidate, systemPrompt: event.target.value || undefined }); confirmation.reset(); }} />
        </label>
        <label className="mt-3 block text-xs text-zinc-400">{labels.model}<input className="mt-1 w-full rounded-lg bg-zinc-700 px-3 py-2 text-zinc-200" value={candidate.model ?? ''} onChange={(event) => { setCandidate({ ...candidate, model: event.target.value }); confirmation.reset(); }} /></label>
        <label className="mt-3 block text-xs text-zinc-400">{labels.provider}<Select selectSize="sm" value={candidate.provider ?? ''} options={[{ value: probe.provider, label: probe.provider }]} onChange={(event) => { setCandidate({ ...candidate, provider: event.target.value }); confirmation.reset(); }} /></label>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {BOOLEAN_HARNESS_DIMENSIONS.map((key) => <label key={key} className="flex min-w-0 items-center justify-between gap-2 rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400 break-words"><span className="min-w-0 break-words">{labels.harnessDimensions[key]}</span><Toggle checked={candidate.harness?.[key] ?? false} onChange={(value) => setHarness(key, value)} aria-label={labels.harnessDimensions[key]} /></label>)}
          <label className="flex items-center justify-between rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400">{labels.memory}<Toggle checked={candidate.memory?.longTerm ?? false} onChange={(value) => { setCandidate({ ...candidate, memory: { ...candidate.memory, longTerm: value } }); confirmation.reset(); }} /></label>
        </div>
        {/* 这组里唯一的下拉：选项文案（按需加载（deferred））在 2 列 grid 的半格里必被截断，给它整行。 */}
        <label className="mt-2 flex min-w-0 items-center justify-between gap-2 rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400"><span className="shrink-0 whitespace-nowrap">{labels.harnessDimensions.toolMode}</span><span className="min-w-0 flex-1"><Select selectSize="sm" value={candidate.harness?.toolMode ?? 'all'} options={[{ value: 'all', label: labels.toolModes.all }, { value: 'deferred', label: labels.toolModes.deferred }]} onChange={(event) => { setCandidate({ ...candidate, harness: { name: candidate.name, ...(candidate.harness ?? {}), toolMode: event.target.value as 'all' | 'deferred' } }); confirmation.reset(); }} /></span></label>
        <label className="mt-3 block text-xs text-zinc-400">{labels.reasoning}<Select selectSize="sm" value={candidate.reasoningEffort ?? ''} options={[{ value: '', label: labels.same }, ...['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value }))]} onChange={(event) => { setCandidate({ ...candidate, reasoningEffort: (event.target.value || undefined) as EvalCompareArm['reasoningEffort'] }); confirmation.reset(); }} /></label>
        <div className="mt-3 text-xs text-zinc-400">{labels.skill}<div className="mt-1 flex flex-wrap gap-1">{probe.skills.map((name) => <button type="button" key={name} aria-pressed={(candidate.skills ?? []).includes(name)} onClick={() => toggleSkill(name)} className={`rounded-full px-2 py-1 ${(candidate.skills ?? []).includes(name) ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 text-zinc-500'}`}>{name}</button>)}</div><p className="mt-1 text-[10px] text-zinc-500">{labels.chooseSkill}</p></div>
        <div className="mt-3 rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400" data-testid="candidate-orchestration">
          <div className="font-medium text-zinc-300">{labels.orchestration}</div>
          <label className="mt-2 flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 break-words">{labels.allowSwarm}</span>
            <Toggle checked={candidate.orchestration?.allowSwarm ?? false} onChange={setAllowSwarm} aria-label={labels.allowSwarm} />
          </label>
          <label className="mt-2 flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 break-words">{labels.spawnMaxDepth}</span>
            <input
              type="number"
              min={0}
              max={SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH}
              aria-label={labels.spawnMaxDepth}
              placeholder={labels.same}
              className="w-20 rounded-lg bg-zinc-700 px-2 py-1 text-zinc-200"
              value={candidate.orchestration?.spawnMaxDepth ?? ''}
              onChange={(event) => setSpawnMaxDepth(event.target.value)}
            />
          </label>
          <p className="mt-1 text-[10px] text-zinc-500">{labels.spawnMaxDepthHint}</p>
          <p className="mt-1 text-[10px] text-zinc-500" data-testid="candidate-orchestration-line">{candidateOrchestrationText}</p>
        </div>
      </section>
    </div>
  </Modal>;
};
