import React, { useCallback, useMemo, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  EvalExperimentCaseItem,
  EvalExperimentDetail,
  EvalExperimentListItem,
  EvalRunPanelProbe,
} from '@shared/contract/evaluation';
import ipcService from '../../../services/ipcService';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import {
  groupExperimentsByDataset,
  normalizeDatasetName,
  type EvalDatasetGroup,
} from './evalDatasetName';
import type { EvalRunPanelLabels } from './EvalRunWizard';

const EVALUATION_GUIDE_URL = 'https://github.com/baochipham942-eng/code-agent/blob/main/docs/architecture/decisions/ADR-036-eval-scoring-credibility-and-redline-jail.md';

interface CaseTransition {
  caseId: string;
  kind: 'regressed' | 'fixed';
  from: string;
  to: string;
}

interface GroupComparison {
  current: EvalExperimentDetail;
  previous: EvalExperimentDetail;
  transitions: CaseTransition[];
}

interface RunGroup {
  key: string;
  split: string;
  k: number;
  caseBankSha: string;
  runs: EvalExperimentListItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? '--' : `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function formatPercent(rate: number | undefined): string {
  if (rate === undefined || Number.isNaN(rate)) return '--';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTimestamp(timestamp: number, language: 'zh' | 'en'): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}

function splitLabel(split: string, labels: EvalRunPanelLabels): string {
  if (split === 'held-in') return labels.dailySet;
  if (split === 'held-out') return labels.heldOutSet;
  if (split === 'safety') return labels.safetySet;
  return split === 'all' ? labels.allSet : split;
}

function caseSide(status: string): 'pass' | 'fail' | null {
  if (status === 'passed') return 'pass';
  if (status === 'failed' || status === 'error') return 'fail';
  return null;
}

function computeTransitions(
  currentCases: EvalExperimentCaseItem[],
  previousCases: EvalExperimentCaseItem[],
): CaseTransition[] {
  const previousByCaseId = new Map(previousCases.map((item) => [item.caseId, item]));
  const transitions: CaseTransition[] = [];
  for (const current of currentCases) {
    const previous = previousByCaseId.get(current.caseId);
    if (!previous) continue;
    const from = caseSide(previous.status);
    const to = caseSide(current.status);
    if (!from || !to || from === to) continue;
    transitions.push({
      caseId: current.caseId,
      kind: to === 'fail' ? 'regressed' : 'fixed',
      from: previous.status,
      to: current.status,
    });
  }
  return transitions;
}

export function getEvalRunConfig(run: EvalExperimentListItem): {
  split: string;
  k: number;
  caseBankSha: string;
  mode?: string;
} {
  const config = run.config ?? {};
  const evalSet = isRecord(config.evalSet) ? config.evalSet : undefined;
  const split = typeof config.split === 'string'
    ? config.split
    : typeof evalSet?.split === 'string' ? evalSet.split : 'all';
  return {
    split,
    k: typeof config.k === 'number' && Number.isFinite(config.k) ? config.k : 1,
    // RUNSTAMP 已为新轮次写入 caseBankSha；unknown 只承接合入前的历史轮次。
    caseBankSha: typeof config.caseBankSha === 'string' ? config.caseBankSha : 'unknown',
    mode: typeof config.mode === 'string' ? config.mode : undefined,
  };
}

function groupRuns(experiments: EvalExperimentListItem[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  const legacyDatasetGroups: EvalDatasetGroup[] = groupExperimentsByDataset(experiments);
  for (const run of legacyDatasetGroups.flatMap((group) => group.runs)) {
    const config = getEvalRunConfig(run);
    if (config.mode === 'mock') continue;
    const key = `${config.split}::${config.k}::${config.caseBankSha}`;
    const group = groups.get(key) ?? {
      key,
      split: config.split,
      k: config.k,
      caseBankSha: config.caseBankSha,
      runs: [],
    };
    group.runs.push(run);
    groups.set(key, group);
  }
  const result = Array.from(groups.values());
  for (const group of result) group.runs.sort((a, b) => b.timestamp - a.timestamp);
  return result.sort((a, b) => (b.runs[0]?.timestamp ?? 0) - (a.runs[0]?.timestamp ?? 0));
}

export function getLatestEvalRun(experiments: EvalExperimentListItem[]): EvalExperimentListItem | undefined {
  return groupRuns(experiments).flatMap((group) => group.runs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function isCompleteRun(run: EvalExperimentListItem): boolean {
  return run.summary?.completed !== false && (run.summary?.notRun ?? 0) === 0;
}

interface EvalRunHistoryProps {
  experiments: EvalExperimentListItem[];
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
  experiments,
  loadState,
  loadError,
  hasActiveRun,
  probe,
  labels,
  language,
  loadingText,
  onRefresh,
  onOpenWizard,
}) => {
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>({});
  const [comparisons, setComparisons] = useState<Record<string, GroupComparison | 'loading' | 'needTwo'>>({});
  const groups = useMemo(() => groupRuns(experiments), [experiments]);
  const quickCost = probe ? probe.estimatedCostPerCaseUsd * probe.quickCheck.maxCases : undefined;

  const loadComparison = useCallback(async (group: RunGroup, selectedIds: string[]) => {
    if (selectedIds.length !== 2) {
      setComparisons((current) => ({ ...current, [group.key]: 'needTwo' }));
      return;
    }
    const selectedRuns = group.runs.filter((run) => selectedIds.includes(run.id));
    if (selectedRuns.length !== 2) return;
    setComparisons((current) => ({ ...current, [group.key]: 'loading' }));
    try {
      const [current, previous] = await Promise.all([
        ipcService.invoke(IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT, selectedRuns[0].id),
        ipcService.invoke(IPC_CHANNELS.EVALUATION_LOAD_EXPERIMENT, selectedRuns[1].id),
      ]);
      if (!current || !previous) throw new Error('missing run');
      setComparisons((existing) => ({
        ...existing,
        [group.key]: {
          current,
          previous,
          transitions: computeTransitions(current.cases, previous.cases),
        },
      }));
    } catch {
      setComparisons((existing) => ({ ...existing, [group.key]: 'needTwo' }));
    }
  }, []);

  const toggleSelected = useCallback((group: RunGroup, run: EvalExperimentListItem) => {
    if (!isCompleteRun(run)) return;
    const current = selectedByGroup[group.key] ?? [];
    const next = current.includes(run.id)
      ? current.filter((id) => id !== run.id)
      : [...current.slice(-1), run.id];
    setSelectedByGroup((value) => ({ ...value, [group.key]: next }));
    void loadComparison(group, next);
  }, [loadComparison, selectedByGroup]);

  const renderComparison = (group: RunGroup) => {
    const comparison = comparisons[group.key];
    if (!comparison || comparison === 'needTwo') return null;
    if (comparison === 'loading') {
      return <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">{labels.compareLoading}</div>;
    }
    const currentRate = comparison.current.experiment.summary?.passRate;
    const previousRate = comparison.previous.experiment.summary?.passRate;
    const regressed = comparison.transitions.filter((item) => item.kind === 'regressed');
    const fixed = comparison.transitions.filter((item) => item.kind === 'fixed');
    const unchanged = Math.max(0, comparison.current.cases.length - comparison.transitions.length);
    return (
      <div className="border-t border-zinc-800 px-3 py-3" data-testid={`benchmark-compare-${group.key}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-zinc-300">{labels.compareTitle}</span>
          <span className="rounded bg-zinc-800 px-2 py-1 font-mono text-zinc-300">
            {formatPercent(previousRate)} → {formatPercent(currentRate)}
          </span>
          <span className="rounded bg-badge-danger px-2 py-1 text-badge-danger">
            {replace(labels.regressedCount, { n: regressed.length })}
          </span>
          <span className="rounded bg-badge-success px-2 py-1 text-badge-success">
            {replace(labels.fixedCount, { n: fixed.length })}
          </span>
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">
            {replace(labels.unchangedCount, { n: unchanged })}
          </span>
        </div>
        {comparison.transitions.length === 0 ? (
          <div className="text-xs text-zinc-500">{labels.noCaseChanges}</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {comparison.transitions.map((item) => (
              <li key={item.caseId} className="flex items-center gap-2">
                <span className={item.kind === 'regressed' ? 'text-badge-danger' : 'text-badge-success'}>
                  {item.kind === 'regressed' ? labels.caseStatusRegressed : labels.caseStatusFixed}
                </span>
                <span className="font-mono text-zinc-300">{item.caseId}</span>
                <span className="text-zinc-500">{item.from} → {item.to}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <>
      {(loadState !== 'ready' || groups.length > 0) && (
        <div className="mx-3 mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">{labels.history}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={onRefresh}
          >
            {labels.refresh}
          </Button>
        </div>
      )}

      {loadState === 'loading' && <div className="px-3 py-8 text-center text-sm text-zinc-500">{loadingText}</div>}
      {loadState === 'error' && (
        <div className="px-3 py-8 text-center text-sm text-zinc-500">
          {replace(labels.loadFailed, { message: loadError ?? '' })}
        </div>
      )}
      {loadState === 'ready' && groups.length === 0 && !hasActiveRun && (
        <div className="min-h-72 flex-1">
          <EmptyState
            variant="plain"
            title={labels.emptyTitle}
            text={(
              <span className="mt-4 flex flex-col items-center gap-3">
                <Button size="sm" onClick={() => onOpenWizard(true)}>
                  {replace(labels.quickCheck, {
                    count: probe?.quickCheck.maxCases ?? 12,
                    cost: formatUsd(quickCost),
                  })}
                </Button>
                <a
                  href={EVALUATION_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline"
                >
                  {labels.scoringDocs}
                </a>
              </span>
            )}
          />
        </div>
      )}

      {loadState === 'ready' && groups.map((group) => (
        <section key={group.key} className="mx-3 mb-3 overflow-hidden rounded-lg bg-zinc-900 shadow-sm" data-testid={`benchmark-group-${group.key}`}>
          <div className="flex items-center gap-2 bg-zinc-800/70 px-3 py-2 text-xs text-zinc-300">
            <span className="font-medium">
              {replace(labels.groupHeader, {
                set: splitLabel(group.split, labels),
                k: group.k,
                sha: group.caseBankSha === 'unknown' ? labels.unknownCaseBank : group.caseBankSha.slice(0, 7),
              })}
            </span>
            <span className="ml-auto text-zinc-500">{replace(labels.runs, { count: group.runs.length })}</span>
          </div>
          <div role="table">
            {group.runs.map((run) => {
              const complete = isCompleteRun(run);
              const selected = (selectedByGroup[group.key] ?? []).includes(run.id);
              return (
                <div
                  key={run.id}
                  role="row"
                  className={`flex items-center gap-3 border-t border-zinc-800 px-3 py-2 text-xs ${complete ? 'text-zinc-300' : 'bg-zinc-900/50 text-zinc-600'}`}
                  data-testid={`benchmark-run-${run.id}`}
                >
                  <button /* ds-allow:button: 历史行对比勾选框，原生 checkbox 视觉无法表达组内最多两轮 */
                    type="button"
                    aria-label={complete ? labels.selectForCompare : labels.incompleteCannotCompare}
                    aria-pressed={selected}
                    disabled={!complete}
                    onClick={() => toggleSelected(group, run)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-zinc-600 disabled:border-zinc-800"
                  >
                    {selected && <Check className="h-3 w-3" />}
                  </button>
                  <span className="min-w-0 flex-1 truncate">{normalizeDatasetName(run.name)}</span>
                  <span className="text-zinc-500">{formatTimestamp(run.timestamp, language)}</span>
                  <span className="w-28 truncate text-zinc-500">{run.model ?? 'unknown'}</span>
                  <span className="w-28 text-right font-mono">
                    {labels.passRate} {formatPercent(run.summary?.passRate)}
                  </span>
                  <span className={`w-14 text-right ${complete ? 'text-badge-success' : 'text-zinc-500'}`}>
                    {complete ? labels.complete : labels.incomplete}
                  </span>
                </div>
              );
            })}
          </div>
          {renderComparison(group)}
          {/* PROMOTE 留位：本卡不提供「设为对比基准」。 */}
        </section>
      ))}
    </>
  );
};
