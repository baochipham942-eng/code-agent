import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import type { EvalExperimentDetail, EvalRunPanelProbe } from '@shared/contract/evaluation';
import type {
  EvalBaselineExperimentListItem,
  EvalBaselineGroupKey,
  EvalBaselineInfo,
  EvalBaselineInfoResult,
  EvalBaselineSetError,
} from '@shared/contract/evaluationBaseline';
import type { EvalRunPanelLabels } from '../i18n/evalRunPanel';
import { invokeEvaluation } from '../evaluationRunIpc';
import { Button } from '@renderer/components/primitives/Button';
import { EmptyState } from '@renderer/components/primitives/EmptyState';
import { groupExperimentsByDataset, normalizeDatasetName, type EvalDatasetGroup } from './evalDatasetName';
import { EvalCaseDrawer, type EvalCaseDrawerTarget } from './EvalCaseDrawer';
import {
  comparabilityTag,
  computeDeltaPp,
  regressionsAgainstBaseline,
  type EvalRunTransition,
} from './evalRunDelta';
import { EvalRunBaselineControls, EvalRunBaselineHeader } from './EvalRunBaselineControls';

const EVALUATION_GUIDE_URL = 'https://github.com/baochipham942-eng/code-agent/blob/main/docs/architecture/decisions/ADR-036-eval-scoring-credibility-and-redline-jail.md';
interface GroupComparison {
  currentExperimentId: string;
  currentRate?: number;
  previousRate?: number;
  transitions: EvalRunTransition[];
  uniqueCaseCount: number;
}
interface RunGroup {
  key: EvalBaselineGroupKey;
  split: string;
  k: number;
  runs: EvalBaselineExperimentListItem[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template,
  );
}
function formatUsd(value: number | undefined): string {
  return value === undefined ? '--' : `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function formatPercent(rate: number | undefined): string {
  if (rate === undefined || Number.isNaN(rate)) return '--';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDelta(delta: number | null): string {
  if (delta === null) return '';
  if (Math.abs(delta).toFixed(1) === '0.0') return '±0 pp';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} pp`;
}

function splitLabel(split: string, labels: EvalRunPanelLabels): string {
  if (split === 'held-in') return labels.dailySet;
  if (split === 'held-out') return labels.heldOutSet;
  if (split === 'safety') return labels.safetySet;
  return split === 'all' ? labels.allSet : split;
}

export function getEvalRunConfig(run: EvalBaselineExperimentListItem): {
  split: string;
  k: number;
  caseBankSha: string;
  mode?: string;
  aggregationRuleVersion?: number;
} {
  const config = run.config ?? {};
  const evalSet = isRecord(config.evalSet) ? config.evalSet : undefined;
  const split = typeof config.split === 'string'
    ? config.split
    : typeof evalSet?.split === 'string' ? evalSet.split : 'all';
  return {
    split,
    k: typeof config.k === 'number' && Number.isFinite(config.k) ? config.k : 1,
    caseBankSha: typeof config.caseBankSha === 'string' ? config.caseBankSha : 'unknown',
    mode: typeof config.mode === 'string' ? config.mode : undefined,
    aggregationRuleVersion: typeof config.aggregationRuleVersion === 'number'
      ? config.aggregationRuleVersion
      : run.summary?.aggregationRuleVersion,
  };
}

function groupRuns(experiments: EvalBaselineExperimentListItem[]): RunGroup[] {
  const groups = new Map<EvalBaselineGroupKey, RunGroup>();
  const datasets: EvalDatasetGroup[] = groupExperimentsByDataset(experiments);
  for (const run of datasets.flatMap((dataset) => dataset.runs)) {
    if (run.source === 'compare') continue;
    const config = getEvalRunConfig(run);
    if (config.mode === 'mock' || config.split === 'control') continue;
    const key = `${config.split}::${config.k}` as EvalBaselineGroupKey;
    const group = groups.get(key) ?? { key, split: config.split, k: config.k, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  const result = Array.from(groups.values());
  for (const group of result) group.runs.sort((a, b) => b.timestamp - a.timestamp);
  return result.sort((a, b) => (b.runs[0]?.timestamp ?? 0) - (a.runs[0]?.timestamp ?? 0));
}

export function getLatestEvalRun(
  experiments: EvalBaselineExperimentListItem[],
): EvalBaselineExperimentListItem | undefined {
  return groupRuns(experiments).flatMap((group) => group.runs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function disabledReason(run: EvalBaselineExperimentListItem, labels: EvalRunPanelLabels): string | undefined {
  const planned = run.summary?.plannedCaseIds;
  if (!planned || planned.length === 0) return labels.legacyRunReason;
  const present = run.caseResults ?? {};
  const missing = Math.max(run.summary?.notRun ?? 0, planned.filter((id) => !(id in present)).length);
  if (run.summary?.completed === false || missing > 0) {
    return replace(labels.incompleteReason, { n: missing });
  }
  const invalid = run.summary?.invalidCases ?? 0;
  if (invalid > 0) return replace(labels.invalidRunReason, { n: invalid });
  if (getEvalRunConfig(run).mode !== 'real') return replace(labels.invalidRunReason, { n: 0 });
  return undefined;
}

function baselinePassRate(baseline: EvalBaselineInfo): number {
  if (baseline.plannedCaseIds.length === 0) return 0;
  const passed = baseline.plannedCaseIds.filter(
    (id) => baseline.caseResults[id]?.status === 'passed',
  ).length;
  return passed / baseline.plannedCaseIds.length;
}

function comparisonFromDetails(current: EvalExperimentDetail, previous: EvalExperimentDetail): GroupComparison {
  const currentCases = Object.fromEntries(current.cases.map((item) => [
    item.caseId, { status: item.status, score: item.score },
  ]));
  const previousCases = Object.fromEntries(previous.cases.map((item) => [
    item.caseId, { status: item.status, score: item.score },
  ]));
  return {
    currentExperimentId: current.experiment.id,
    currentRate: current.experiment.summary?.passRate,
    previousRate: previous.experiment.summary?.passRate,
    ...regressionsAgainstBaseline(previousCases, currentCases),
  };
}

interface EvalRunHistoryProps {
  experiments: EvalBaselineExperimentListItem[];
  loadState: 'loading' | 'ready' | 'error';
  loadError: string | null;
  hasActiveRun: boolean;
  probe: EvalRunPanelProbe | null;
  labels: EvalRunPanelLabels;
  language: 'zh' | 'en';
  loadingText: string;
  onRefresh(): void;
  onOpenWizard(quick: boolean): void;
}

export const EvalRunHistory: React.FC<EvalRunHistoryProps> = ({
  experiments, loadState, loadError, hasActiveRun, probe, labels, language,
  loadingText, onRefresh, onOpenWizard,
}) => {
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>({});
  const [comparisons, setComparisons] = useState<Record<string, GroupComparison | 'loading'>>({});
  const [baselineGroups, setBaselineGroups] = useState<EvalBaselineInfoResult['groups']>({});
  const [setErrors, setSetErrors] = useState<Record<string, EvalBaselineSetError>>({});
  const [drawerTarget, setDrawerTarget] = useState<EvalCaseDrawerTarget | null>(null);
  const groups = useMemo(() => groupRuns(experiments), [experiments]);
  const quickCost = probe ? probe.estimatedCostPerCaseUsd * probe.quickCheck.maxCases : undefined;
  useEffect(() => {
    void invokeEvaluation(EVALUATION_CHANNELS.BASELINE_INFO)
      .then((result) => setBaselineGroups(result?.groups ?? {}))
      .catch(() => setBaselineGroups({}));
  }, [experiments]);

  const loadComparison = useCallback(async (group: RunGroup, selectedIds: string[]) => {
    if (selectedIds.length !== 2) return;
    const selectedRuns = group.runs.filter((run) => selectedIds.includes(run.id));
    if (selectedRuns.length !== 2) return;
    setComparisons((current) => ({ ...current, [group.key]: 'loading' }));
    try {
      const [current, previous] = await Promise.all([
        invokeEvaluation(EVALUATION_CHANNELS.LOAD_EXPERIMENT, selectedRuns[0].id),
        invokeEvaluation(EVALUATION_CHANNELS.LOAD_EXPERIMENT, selectedRuns[1].id),
      ]);
      if (!current || !previous) throw new Error('missing run');
      setComparisons((existing) => ({
        ...existing, [group.key]: comparisonFromDetails(current, previous),
      }));
    } catch {
      setComparisons((existing) => {
        const next = { ...existing };
        delete next[group.key];
        return next;
      });
    }
  }, []);

  const toggleSelected = useCallback((group: RunGroup, run: EvalBaselineExperimentListItem) => {
    const baseline = baselineGroups[group.key];
    const tag = baseline ? comparabilityTag({
      baselineAggregationRuleVersion: baseline.aggregationRuleVersion,
      runAggregationRuleVersion: getEvalRunConfig(run).aggregationRuleVersion,
      baselineCaseBankSha: baseline.caseBankSha,
      runCaseBankSha: getEvalRunConfig(run).caseBankSha,
    }) : 'comparable';
    if (disabledReason(run, labels) || tag === 'old-rule') return;
    const current = selectedByGroup[group.key] ?? [];
    const next = current.includes(run.id)
      ? current.filter((id) => id !== run.id)
      : [...current.slice(-1), run.id];
    setSelectedByGroup((value) => ({ ...value, [group.key]: next }));
    void loadComparison(group, next);
  }, [baselineGroups, labels, loadComparison, selectedByGroup]);

  const setBaseline = useCallback(async (group: RunGroup, experimentId: string) => {
    const result = await invokeEvaluation(EVALUATION_CHANNELS.SET_BASELINE, { experimentId });
    if ('baseline' in result) {
      setBaselineGroups((current) => ({ ...current, [group.key]: result.baseline }));
      setSetErrors((current) => {
        const next = { ...current };
        delete next[group.key];
        return next;
      });
      onRefresh();
      return;
    }
    setSetErrors((current) => ({ ...current, [group.key]: result.error }));
  }, [onRefresh]);

  const compareAgainstBaseline = useCallback((
    group: RunGroup, run: EvalBaselineExperimentListItem, baseline: EvalBaselineInfo,
  ) => {
    setComparisons((current) => ({
      ...current,
      [group.key]: {
        currentExperimentId: run.id,
        currentRate: run.summary?.passRate,
        previousRate: baselinePassRate(baseline),
        ...regressionsAgainstBaseline(baseline.caseResults, run.caseResults ?? {}),
      },
    }));
  }, []);

  const renderComparison = (group: RunGroup) => {
    const comparison = comparisons[group.key];
    if (!comparison) return null;
    if (comparison === 'loading') {
      return <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">{labels.compareLoading}</div>;
    }
    const regressed = comparison.transitions.filter((item) => item.kind === 'regressed');
    const fixed = comparison.transitions.filter((item) => item.kind === 'fixed');
    return (
      <div className="border-t border-zinc-800 px-3 py-3" data-testid={`benchmark-compare-${group.key}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-zinc-300">{labels.compareTitle}</span>
          <span className="rounded bg-zinc-800 px-2 py-1 font-mono text-zinc-300">
            {formatPercent(comparison.previousRate)} → {formatPercent(comparison.currentRate)}
          </span>
          <span className="rounded bg-badge-danger px-2 py-1 text-badge-danger">
            {replace(labels.regressed, { n: regressed.length })}
          </span>
          <span className="rounded bg-badge-success px-2 py-1 text-badge-success">
            {replace(labels.fixedCount, { n: fixed.length })}
          </span>
        </div>
        <ul className="space-y-1 text-xs">
          {comparison.transitions.map((item) => (
            <li key={item.caseId}>
              <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-left" onClick={() => setDrawerTarget({ experimentId: comparison.currentExperimentId, caseId: item.caseId })}>
                <span className={item.kind === 'regressed' ? 'text-badge-danger' : 'text-badge-success'}>
                  {item.kind === 'regressed' ? labels.caseStatusRegressed : labels.caseStatusFixed}
                </span>
                <span className="font-mono text-zinc-300">{item.caseId}</span>
                <span className="text-zinc-500">{item.from} → {item.to}</span>
              </Button>
            </li>
          ))}
          {comparison.uniqueCaseCount > 0 && (
            <li className="rounded bg-zinc-800 px-2 py-1 text-zinc-500">
              {replace(labels.uniqueCases, { n: comparison.uniqueCaseCount })}
            </li>
          )}
        </ul>
      </div>
    );
  };

  return (
    <>
      <div className={drawerTarget ? 'opacity-45 saturate-50 transition' : 'transition'}>
        {(loadState !== 'ready' || groups.length > 0) && (
          <div className="mx-3 mb-2 flex items-center gap-2">
            <span className="text-xs font-medium text-zinc-300">{labels.history}</span>
            <Button variant="ghost" size="sm" className="ml-auto" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRefresh}>{labels.refresh}</Button>
          </div>
        )}
        {loadState === 'loading' && <div className="px-3 py-8 text-center text-sm text-zinc-500">{loadingText}</div>}
        {loadState === 'error' && <div className="px-3 py-8 text-center text-sm text-zinc-500">{replace(labels.loadFailed, { message: loadError ?? '' })}</div>}
        {loadState === 'ready' && groups.length === 0 && !hasActiveRun && (
          <div className="min-h-72 flex-1">
            <EmptyState variant="plain" title={labels.emptyTitle} text={(
              <span className="mt-4 flex flex-col items-center gap-3">
                <Button size="sm" onClick={() => onOpenWizard(true)}>
                  {replace(labels.quickCheck, { count: probe?.quickCheck.maxCases ?? 12, cost: formatUsd(quickCost) })}
                </Button>
                <a href={EVALUATION_GUIDE_URL} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline">{labels.scoringDocs}</a>
              </span>
            )} />
          </div>
        )}
        {loadState === 'ready' && groups.map((group) => {
          const baseline = baselineGroups[group.key];
          const orderedRuns = baseline?.experimentId
            ? [...group.runs].sort((a, b) => {
              if (a.id === baseline.experimentId) return -1;
              if (b.id === baseline.experimentId) return 1;
              return b.timestamp - a.timestamp;
            })
            : group.runs;
          return (
            <section key={group.key} className="mx-3 mb-3 overflow-hidden rounded-lg bg-zinc-900 shadow-sm" data-testid={`benchmark-group-${group.key}`}>
              <EvalRunBaselineHeader title={`${splitLabel(group.split, labels)} · k=${group.k}`} runCount={group.runs.length} baseline={baseline} labels={labels} language={language} />
              <div role="table">
                {orderedRuns.map((run) => {
                  const config = getEvalRunConfig(run);
                  const current = baseline?.experimentId === run.id;
                  const reason = disabledReason(run, labels);
                  const tag = baseline ? comparabilityTag({
                    baselineAggregationRuleVersion: baseline.aggregationRuleVersion,
                    runAggregationRuleVersion: config.aggregationRuleVersion,
                    baselineCaseBankSha: baseline.caseBankSha,
                    runCaseBankSha: config.caseBankSha,
                  }) : 'comparable';
                  const selected = (selectedByGroup[group.key] ?? []).includes(run.id);
                  const delta = baseline && !current && tag !== 'old-rule'
                    ? computeDeltaPp(run.summary?.passRate, baselinePassRate(baseline)) : null;
                  const regression = baseline && !current && tag !== 'old-rule'
                    ? regressionsAgainstBaseline(baseline.caseResults, run.caseResults ?? {}) : null;
                  const regressedCount = regression?.transitions.filter((item) => item.kind === 'regressed').length ?? 0;
                  return (
                    <div key={run.id} role="row" className={`flex items-center gap-3 border-t border-zinc-800 px-3 py-2 text-xs ${current ? 'bg-zinc-800/40' : 'text-zinc-300'}`} data-testid={`benchmark-run-${run.id}`}>
                      <button /* ds-allow:button: 历史行对比勾选框，原生 checkbox 视觉无法表达组内最多两轮 */ type="button" aria-label={reason || tag === 'old-rule' ? labels.incompleteCannotCompare : labels.selectForCompare} aria-pressed={selected} disabled={Boolean(reason) || tag === 'old-rule'} onClick={() => toggleSelected(group, run)} className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-zinc-600 disabled:border-zinc-800">
                        {selected && <Check className="h-3 w-3" />}
                      </button>
                      <span className="min-w-0 flex-1 truncate">{normalizeDatasetName(run.name)}</span>
                      <span className="text-zinc-500">{new Date(run.timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
                      <span className="w-24 truncate text-zinc-500">{run.model ?? 'unknown'}</span>
                      <span className="w-32 text-right font-mono">
                        {labels.passRate} {formatPercent(run.summary?.passRate)}
                        {delta !== null && <span className={`ml-1 ${delta < 0 ? 'text-badge-danger' : delta > 0 ? 'text-badge-success' : 'text-zinc-500'}`}>{formatDelta(delta)}</span>}
                      </span>
                      <span className="w-28 text-right text-zinc-500">
                        {tag === 'case-bank-updated' && <><span>{labels.caseBankUpdated}</span><small className="block">{labels.compareSharedCases}</small></>}
                        {tag === 'old-rule' && <span>{labels.oldScoringRule}</span>}
                      </span>
                      <span className="w-20 text-right">
                        {regression && <button /* ds-allow:button: 退步计数直接展开组内逐题变化 */ type="button" className={regressedCount > 0 ? 'text-badge-danger' : 'text-zinc-500'} onClick={() => baseline && compareAgainstBaseline(group, run, baseline)}>{replace(labels.regressed, { n: regressedCount })}</button>}
                      </span>
                      <span className={`w-14 text-right ${run.summary?.completed === false ? 'text-zinc-500' : 'text-badge-success'}`}>
                        {run.summary?.completed === false ? labels.incomplete : labels.complete}
                      </span>
                      <EvalRunBaselineControls current={current} disabledReason={reason} labels={labels} onSet={() => void setBaseline(group, run.id)} />
                    </div>
                  );
                })}
              </div>
              {setErrors[group.key] && <div className="border-t border-zinc-800 px-3 py-1 text-xs text-badge-danger">{labels.setReferenceFailed}</div>}
              {renderComparison(group)}
            </section>
          );
        })}
      </div>
      {drawerTarget && <EvalCaseDrawer target={drawerTarget} onClose={() => setDrawerTarget(null)} />}
    </>
  );
};
