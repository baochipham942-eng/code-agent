// ============================================================================
// EvalBenchmarksTab - 评测中心「跑分」tab（2026-08-29 爸拍板 R4）
//
// 一条纵向流：开跑条 → 进行中（有 run 才出现）→ 历史。界面只发真实运行；
// renderer 只传 scope/split/tags/maxCases，模型、密钥、目录和价格均由 host 决定。
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, Circle, Minus, RefreshCw, Square, X } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  EvalExperimentCaseItem,
  EvalExperimentDetail,
  EvalExperimentListItem,
  EvalRunEvent,
  EvalRunPanelProbe,
  EvalRunRequest,
  EvalRunSubscriptionResult,
} from '@shared/contract/evaluation';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';
import { Modal } from '../../primitives/Modal';
import {
  groupExperimentsByDataset,
  normalizeDatasetName,
  type EvalDatasetGroup,
} from './evalDatasetName';

const RUN_CONFIRM_WINDOW_MS = 5_000;
const EVALUATION_GUIDE_URL = 'https://github.com/baochipham942-eng/code-agent/blob/main/docs/architecture/decisions/ADR-036-eval-scoring-credibility-and-redline-jail.md';

type LoadState = 'loading' | 'ready' | 'error';
type RunSplit = Extract<NonNullable<EvalRunRequest['split']>, 'held-in' | 'held-out' | 'safety'>;
type CasePresentationStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'excluded';
type Labels = ReturnType<typeof useI18n>['t']['evalCenter']['runPanel'];

interface CasePresentation {
  id: string;
  status: CasePresentationStatus;
  result: string;
}

interface LogLine {
  id: string;
  text: string;
  caseId?: string;
  kind?: 'tools';
}

interface ActiveRun {
  runId: string;
  split: RunSplit;
  model: string;
  provider: string;
  plannedCaseIds: string[];
  cases: Record<string, CasePresentation>;
  currentCaseId?: string;
  startTs: number;
  lastTs: number;
  logs: LogLine[];
  toolCounts: Record<string, number>;
  stopping: boolean;
}

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

const TAG_OPTIONS = [
  { id: 'core-path', labelKey: 'tagCorePath' },
  { id: 'recovery', labelKey: 'tagRecovery' },
  { id: 'conversation', labelKey: 'tagConversation' },
  { id: 'multi-turn', labelKey: 'tagMultiTurn' },
  { id: 'spreadsheet', labelKey: 'tagSpreadsheet' },
  { id: 'web', labelKey: 'tagWeb' },
] as const;

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

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTimestamp(timestamp: number, language: 'zh' | 'en'): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}

function splitLabel(split: string, labels: Labels): string {
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

function computeTransitions(currentCases: EvalExperimentCaseItem[], previousCases: EvalExperimentCaseItem[]): CaseTransition[] {
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

function runConfig(run: EvalExperimentListItem): {
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
    caseBankSha: typeof config.caseBankSha === 'string' ? config.caseBankSha : 'unknown',
    mode: typeof config.mode === 'string' ? config.mode : undefined,
  };
}

function groupRuns(experiments: EvalExperimentListItem[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  const legacyDatasetGroups: EvalDatasetGroup[] = groupExperimentsByDataset(experiments);
  for (const run of legacyDatasetGroups.flatMap((group) => group.runs)) {
    const config = runConfig(run);
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

function isCompleteRun(run: EvalExperimentListItem): boolean {
  return run.summary?.completed !== false && (run.summary?.notRun ?? 0) === 0;
}

function appendLog(run: ActiveRun, line: LogLine): LogLine[] {
  if (line.kind === 'tools' && line.caseId) {
    const existing = run.logs.findIndex((item) => item.kind === 'tools' && item.caseId === line.caseId);
    if (existing >= 0) return run.logs.map((item, index) => index === existing ? line : item);
  }
  return [...run.logs, line];
}

export const EvalBenchmarksTab: React.FC = () => {
  const { t, language } = useI18n();
  const labels = t.evalCenter.runPanel;
  const [experiments, setExperiments] = useState<EvalExperimentListItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probe, setProbe] = useState<EvalRunPanelProbe | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [split, setSplit] = useState<RunSplit>('held-in');
  const [tags, setTags] = useState<string[]>([]);
  const [maxCases, setMaxCases] = useState(1);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [quietNotice, setQuietNotice] = useState<string | null>(null);
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>({});
  const [comparisons, setComparisons] = useState<Record<string, GroupComparison | 'loading' | 'needTwo'>>({});
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);

  const loadExperiments = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const list = await ipcService.invoke(IPC_CHANNELS.EVALUATION_LIST_EXPERIMENTS, { limit: 100 });
      setExperiments(list ?? []);
      setLoadState('ready');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void loadExperiments();
    void ipcService.invoke(IPC_CHANNELS.EVALUATION_RUN_EVENTS).then((result) => {
      if (result && 'environment' in result) {
        setProbe(result);
        setMaxCases(result.splitCounts['held-in']);
      }
    });
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      unsubscribeRef.current?.();
    };
  }, [loadExperiments]);

  const groups = useMemo(() => groupRuns(experiments), [experiments]);
  const lastRun = useMemo(() => groups.flatMap((group) => group.runs)
    .sort((a, b) => b.timestamp - a.timestamp)[0], [groups]);
  const estimatedCost = probe ? probe.estimatedCostPerCaseUsd * maxCases : undefined;
  const quickCost = probe ? probe.estimatedCostPerCaseUsd * probe.quickCheck.maxCases : undefined;

  const openWizard = useCallback((quick = false) => {
    setQuietNotice(null);
    setWizardOpen(true);
    setConfirmArmed(false);
    setSplit('held-in');
    setTags(quick ? (probe?.quickCheck.tags ?? ['core-path']) : []);
    setMaxCases(quick ? (probe?.quickCheck.maxCases ?? 12) : (probe?.splitCounts['held-in'] ?? 1));
  }, [probe]);

  const closeWizard = useCallback(() => {
    if (starting) return;
    setWizardOpen(false);
    setConfirmArmed(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, [starting]);

  const updateActiveRunFromEvent = useCallback((event: EvalRunEvent) => {
    if (event.schemaVersion !== 2) {
      setQuietNotice(labels.quietDegraded);
      setActiveRun(null);
      void loadExperiments();
      return;
    }
    if (event.type === 'error') {
      setQuietNotice(labels.quietDegraded);
      setActiveRun(null);
      unsubscribeRef.current?.();
      void loadExperiments();
      return;
    }
    if (event.type === 'run_end') {
      setQuietNotice(event.aborted ? labels.incomplete : null);
      setActiveRun(null);
      unsubscribeRef.current?.();
      void loadExperiments();
      return;
    }

    setActiveRun((current) => {
      if (current?.runId !== event.runId) return current;
      const next: ActiveRun = { ...current, lastTs: event.ts };
      if (event.type === 'run_start') {
        const cases = Object.fromEntries(event.plannedCaseIds.map((id) => [id, {
          id,
          status: 'waiting' as const,
          result: labels.noResult,
        }]));
        return {
          ...next,
          model: event.config.model,
          provider: event.config.provider,
          plannedCaseIds: event.plannedCaseIds,
          cases,
          startTs: event.ts,
          logs: appendLog(next, { id: `${event.ts}:start`, text: labels.runStarted }),
        };
      }
      if (event.type === 'case_start') {
        const item: CasePresentation = { id: event.testId, status: 'running', result: labels.running };
        return {
          ...next,
          currentCaseId: event.testId,
          cases: { ...next.cases, [event.testId]: item },
          logs: appendLog(next, {
            id: `${event.ts}:case-start:${event.testId}`,
            caseId: event.testId,
            text: replace(labels.caseStarted, { caseId: event.testId }),
          }),
        };
      }
      if (event.type === 'case_end') {
        let status: CasePresentationStatus = 'failed';
        let result = event.failureReason ?? labels.failed;
        if (event.status === 'passed') {
          status = 'passed';
          result = labels.passed;
        } else if (event.status === 'infra_excluded') {
          status = 'excluded';
          result = labels.excluded;
        } else if (['skipped', 'partial', 'cost_exceeded', 'not_run'].includes(event.status)) {
          status = 'excluded';
          result = event.status === 'cost_exceeded' ? labels.costExceeded : labels.skipped;
        }
        const line = status === 'passed'
          ? replace(labels.casePassed, { caseId: event.testId })
          : status === 'excluded'
            ? replace(labels.caseExcluded, { caseId: event.testId })
            : replace(labels.caseFailed, { caseId: event.testId, reason: result });
        return {
          ...next,
          cases: { ...next.cases, [event.testId]: { id: event.testId, status, result } },
          logs: appendLog(next, { id: `${event.ts}:case-end:${event.testId}`, caseId: event.testId, text: line }),
        };
      }
      if (event.type === 'tool_call') {
        const count = (next.toolCounts[event.testId] ?? 0) + 1;
        return {
          ...next,
          toolCounts: { ...next.toolCounts, [event.testId]: count },
          logs: appendLog(next, {
            id: `tools:${event.testId}`,
            kind: 'tools',
            caseId: event.testId,
            text: replace(labels.toolsCalled, { caseId: event.testId, count }),
          }),
        };
      }
      if (event.type === 'skill_activated') {
        return { ...next, logs: appendLog(next, {
          id: `${event.ts}:skill:${event.testId}`,
          caseId: event.testId,
          text: replace(labels.skillActivated, { caseId: event.testId, name: event.name }),
        }) };
      }
      if (event.type === 'memory_injected') {
        return { ...next, logs: appendLog(next, {
          id: `${event.ts}:memory:${event.testId}`,
          caseId: event.testId,
          text: replace(labels.memoryInjected, { caseId: event.testId }),
        }) };
      }
      if (event.type === 'subagent_spawned') {
        return { ...next, logs: appendLog(next, {
          id: `${event.ts}:collaborator:${event.testId}`,
          caseId: event.testId,
          text: replace(labels.subagentSpawned, { caseId: event.testId }),
        }) };
      }
      return next;
    });
  }, [labels, loadExperiments]);

  const startRun = useCallback(async () => {
    setStarting(true);
    setQuietNotice(null);
    try {
      const request: EvalRunRequest = {
        scope: 'full',
        split,
        maxCases,
        ...(tags.length > 0 ? { tags } : {}),
      };
      const runResult = await ipcService.invoke(IPC_CHANNELS.EVALUATION_RUN_SUITE, request);
      if (!runResult || typeof runResult.runId !== 'string' || runResult.runId.length === 0) {
        throw new Error('Evaluation run did not return a runId');
      }
      const { runId } = runResult;
      const now = Date.now();
      setActiveRun({
        runId,
        split,
        model: probe?.model ?? 'unknown',
        provider: probe?.provider ?? 'unknown',
        plannedCaseIds: [],
        cases: {},
        startTs: now,
        lastTs: now,
        logs: [],
        toolCounts: {},
        stopping: false,
      });
      setWizardOpen(false);
      setConfirmArmed(false);

      let receivedRunEnd = false;
      // 事件契约：先挂监听，再向 host 确认订阅，避免 subscribe 同步推首批事件时漏掉 run_start。
      unsubscribeRef.current?.();
      const unsubscribe = ipcService.on(IPC_CHANNELS.EVALUATION_RUN_EVENTS, (event) => {
        if (event.runId !== runId) return;
        if (event.type === 'run_end') receivedRunEnd = true;
        updateActiveRunFromEvent(event);
      });
      unsubscribeRef.current = unsubscribe;
      if (!unsubscribe) {
        setQuietNotice(labels.quietDegraded);
        setActiveRun(null);
        return;
      }
      const subscription = await ipcService.invoke(IPC_CHANNELS.EVALUATION_RUN_EVENTS, { runId }) as EvalRunSubscriptionResult;
      if (!subscription.running && !receivedRunEnd) {
        setQuietNotice(labels.endedBeforeSubscribe);
        setActiveRun(null);
        unsubscribe();
        void loadExperiments();
      }
    } catch {
      setQuietNotice(labels.runFailed);
    } finally {
      setStarting(false);
    }
  }, [labels, loadExperiments, maxCases, probe, split, tags, updateActiveRunFromEvent]);

  const handleRunClick = useCallback(() => {
    if (confirmArmed) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      void startRun();
      return;
    }
    setConfirmArmed(true);
    confirmTimerRef.current = setTimeout(() => setConfirmArmed(false), RUN_CONFIRM_WINDOW_MS);
  }, [confirmArmed, startRun]);

  const stopRun = useCallback(async () => {
    if (!activeRun || activeRun.stopping) return;
    setActiveRun((current) => current ? { ...current, stopping: true } : current);
    try {
      await ipcService.invoke(IPC_CHANNELS.EVALUATION_ABORT_RUN, { runId: activeRun.runId });
    } catch {
      setQuietNotice(labels.quietDegraded);
      setActiveRun(null);
      void loadExperiments();
    }
  }, [activeRun, labels.quietDegraded, loadExperiments]);

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
        [group.key]: { current, previous, transitions: computeTransitions(current.cases, previous.cases) },
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
          <span className="rounded bg-zinc-800 px-2 py-1 font-mono text-zinc-300">{formatPercent(previousRate)} → {formatPercent(currentRate)}</span>
          <span className="rounded bg-badge-danger px-2 py-1 text-badge-danger">{replace(labels.regressedCount, { n: regressed.length })}</span>
          <span className="rounded bg-badge-success px-2 py-1 text-badge-success">{replace(labels.fixedCount, { n: fixed.length })}</span>
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">{replace(labels.unchangedCount, { n: unchanged })}</span>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950" data-testid="eval-benchmarks-tab">
      <div className="m-3 flex shrink-0 items-center rounded-lg bg-zinc-900 px-3 py-2 shadow-sm">
        <Button size="sm" onClick={() => openWizard(false)}>{labels.launch}</Button>
        {lastRun && (
          <span className="ml-auto text-xs text-zinc-500">
            {replace(labels.lastRun, {
              set: splitLabel(runConfig(lastRun).split, labels),
              model: lastRun.model ?? 'unknown',
              k: runConfig(lastRun).k,
            })}
          </span>
        )}
      </div>

      {activeRun && <RunningPanel run={activeRun} labels={labels} onStop={() => void stopRun()} />}

      {quietNotice && (
        <div className="mx-3 mb-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400" role="status">{quietNotice}</div>
      )}

      {(loadState !== 'ready' || groups.length > 0) && (
        <div className="mx-3 mb-2 flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">{labels.history}</span>
          <Button variant="ghost" size="sm" className="ml-auto" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadExperiments()}>
            {labels.refresh}
          </Button>
        </div>
      )}

      {loadState === 'loading' && <div className="px-3 py-8 text-center text-sm text-zinc-500">{t.settings.modal.loading}</div>}
      {loadState === 'error' && (
        <div className="px-3 py-8 text-center text-sm text-zinc-500">{replace(labels.loadFailed, { message: loadError ?? '' })}</div>
      )}
      {loadState === 'ready' && groups.length === 0 && !activeRun && (
        <div className="min-h-72 flex-1">
          <EmptyState
            variant="plain"
            title={labels.emptyTitle}
            text={(
              <span className="mt-4 flex flex-col items-center gap-3">
                <Button size="sm" onClick={() => openWizard(true)}>
                  {replace(labels.quickCheck, { count: probe?.quickCheck.maxCases ?? 12, cost: formatUsd(quickCost) })}
                </Button>
                <a href={EVALUATION_GUIDE_URL} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline">
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
                  <span className="w-28 text-right font-mono">{labels.passRate} {formatPercent(run.summary?.passRate)}</span>
                  <span className={`w-14 text-right ${complete ? 'text-badge-success' : 'text-zinc-500'}`}>{complete ? labels.complete : labels.incomplete}</span>
                </div>
              );
            })}
          </div>
          {renderComparison(group)}
          {/* PROMOTE 留位：本卡不提供「设为对比基准」。 */}
        </section>
      ))}

      <RunWizard
        open={wizardOpen}
        probe={probe}
        split={split}
        tags={tags}
        maxCases={maxCases}
        confirmArmed={confirmArmed}
        starting={starting}
        estimatedCost={estimatedCost}
        labels={labels}
        onClose={closeWizard}
        onSplit={(next) => {
          setSplit(next);
          setMaxCases(probe?.splitCounts[next] ?? 1);
          setConfirmArmed(false);
        }}
        onToggleTag={(tag) => {
          setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
          setConfirmArmed(false);
        }}
        onMaxCases={(next) => {
          setMaxCases(next);
          setConfirmArmed(false);
        }}
        onRun={handleRunClick}
      />
    </div>
  );
};

interface RunWizardProps {
  open: boolean;
  probe: EvalRunPanelProbe | null;
  split: RunSplit;
  tags: string[];
  maxCases: number;
  confirmArmed: boolean;
  starting: boolean;
  estimatedCost?: number;
  labels: Labels;
  onClose(): void;
  onSplit(split: RunSplit): void;
  onToggleTag(tag: string): void;
  onMaxCases(value: number): void;
  onRun(): void;
}

const RunWizard: React.FC<RunWizardProps> = ({
  open, probe, split, tags, maxCases, confirmArmed, starting, estimatedCost,
  labels, onClose, onSplit, onToggleTag, onMaxCases, onRun,
}) => {
  const safetyAvailable = probe?.environment.osJail.active === true;
  const footer = (
    <div className="flex w-full items-center gap-3 bg-badge-warning px-4 py-3">
      <span className="text-xs text-badge-warning">
        <span className="block">{replace(labels.estimatedCost, { cost: formatUsd(estimatedCost), version: probe?.priceTableVersion ?? '—' })}</span>
        {confirmArmed && <span className="mt-0.5 block text-[10px]">{labels.confirmSafety}</span>}
      </span>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose} disabled={starting}>{labels.cancel}</Button>
      <Button
        variant={confirmArmed ? 'secondary' : 'primary'}
        size="sm"
        style={confirmArmed ? { background: 'var(--badge-warning-fg)', color: 'var(--text-inverse)' } : undefined}
        loading={starting}
        onClick={onRun}
        data-testid="eval-run-confirm"
      >
        {starting
          ? labels.starting
          : confirmArmed
            ? replace(labels.confirmRun, { model: probe?.model ?? 'unknown', count: maxCases, cost: formatUsd(estimatedCost) })
            : labels.runAndBill}
      </Button>
    </div>
  );

  return (
    <Modal isOpen={open} onClose={onClose} title={labels.wizardTitle} size="full" footer={footer} portal>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.datasetSection}</h3>
          <div className="space-y-2">
            {([
              ['held-in', labels.dailySet],
              ['held-out', labels.heldOutSet],
              ['safety', labels.safetySet],
            ] as const).map(([value, label]) => {
              const disabled = value === 'safety' && !safetyAvailable;
              return (
                <button /* ds-allow:button: 评测集单选卡片，Button primitive 无整行 radio card 变体 */
                  key={value}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSplit(value)}
                  className={`flex w-full items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-left text-xs ${split === value ? 'ring-1 ring-zinc-500' : ''} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Circle className={`h-3 w-3 ${split === value ? 'fill-zinc-300 text-zinc-300' : 'text-zinc-600'}`} />
                  <span className="text-zinc-200">{label}</span>
                  <span className="ml-auto text-zinc-500">{probe?.splitCounts[value] ?? '—'}</span>
                </button>
              );
            })}
          </div>
          {!safetyAvailable && <p className="mt-2 text-xs text-zinc-500">{labels.safetyUnavailable}</p>}
          <div className="mt-4">
            <div className="mb-2 text-xs text-zinc-400">{labels.tags}</div>
            <div className="flex flex-wrap gap-1.5">
              {TAG_OPTIONS.map((option) => (
                <button /* ds-allow:button: 标签 chip 多选，Button primitive 的 padding/圆角密度不适用 */
                  key={option.id}
                  type="button"
                  aria-pressed={tags.includes(option.id)}
                  onClick={() => onToggleTag(option.id)}
                  className={`rounded-full px-2 py-1 text-xs ${tags.includes(option.id) ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-500'}`}
                >
                  {labels[option.labelKey]}
                </button>
              ))}
            </div>
          </div>
          <label className="mt-4 block text-xs text-zinc-400">
            {labels.maxCases}
            <input
              type="number"
              min={1}
              max={probe?.splitCounts[split] ?? 500}
              value={maxCases}
              onChange={(event) => onMaxCases(Math.max(1, Number(event.target.value) || 1))}
              className="mt-1 w-full rounded-lg bg-zinc-800 px-3 py-2 text-zinc-200 outline-hidden ring-1 ring-zinc-700 focus:ring-accent-accessible"
            />
          </label>
          {maxCases > 50 && <p className="mt-2 text-xs text-badge-warning">{labels.expensiveHint}</p>}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.shapeSection}</h3>
          <div className="rounded-lg bg-zinc-800 p-3 text-xs leading-5 text-zinc-400">{labels.productionShape}</div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-zinc-200">{labels.scorerSection}</h3>
          <div className="flex items-start gap-2 rounded-lg bg-zinc-800 p-3 text-xs">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-zinc-700 text-zinc-100"><Check className="h-3 w-3" /></span>
            <span>
              <span className="block text-zinc-200">{labels.deterministicScorer}</span>
              <span className="text-zinc-500">{labels.locked}</span>
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-zinc-800/60 p-3 text-xs text-zinc-600" aria-disabled="true">
            <Square className="h-4 w-4" />
            <span>{labels.aiJudge}</span>
            <span className="ml-auto">{labels.nextVersion}</span>
          </div>
        </section>
      </div>
    </Modal>
  );
};

interface RunningPanelProps {
  run: ActiveRun;
  labels: Labels;
  onStop(): void;
}

const RunningPanel: React.FC<RunningPanelProps> = ({ run, labels, onStop }) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const cases = run.plannedCaseIds.map((id) => run.cases[id] ?? { id, status: 'waiting' as const, result: labels.noResult });
  const completed = cases.filter((item) => !['waiting', 'running'].includes(item.status)).length;
  const runningIndex = cases.findIndex((item) => item.status === 'running');
  const current = cases.length === 0 ? 0 : Math.min(cases.length, runningIndex >= 0 ? runningIndex + 1 : completed);

  return (
    <section className="mx-3 mb-3 overflow-hidden rounded-lg bg-zinc-900 shadow-sm" data-testid="eval-run-active">
      <div className="flex items-center gap-3 bg-zinc-800/70 px-3 py-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-200">
          {replace(labels.runningSet, {
            set: splitLabel(run.split, labels), model: run.model, current, total: cases.length || '—',
            duration: formatDuration(run.lastTs - run.startTs),
          })}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto text-[var(--cc-error)]" onClick={onStop} disabled={run.stopping}>
          {run.stopping ? labels.stopping : labels.stop}
        </Button>
      </div>
      <div className="grid min-h-80 grid-cols-1 lg:grid-cols-[2fr_3fr]">
        <div className="max-h-96 overflow-y-auto border-b border-zinc-800 lg:border-b-0 lg:border-r">
          {cases.map((item) => (
            <div key={item.id} className={`flex items-center gap-2 border-b border-zinc-800/70 px-3 py-2 text-xs ${item.status === 'running' ? 'bg-zinc-800/60' : ''}`}>
              <CaseStatusIcon status={item.status} />
              <span className="w-36 truncate font-mono text-zinc-300">{item.id}</span>
              <span className={`min-w-0 flex-1 truncate ${item.status === 'failed' ? 'text-[var(--cc-error)]' : item.status === 'passed' ? 'text-[var(--cc-success)]' : 'text-zinc-500'}`}>
                {item.result}
              </span>
            </div>
          ))}
        </div>
        <div className="relative min-h-80 bg-zinc-950">
          <div className="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-400">{labels.logTitle}</div>
          <Virtuoso
            ref={virtuosoRef}
            role="log"
            aria-live="polite"
            data={run.logs}
            className="h-64 font-mono text-xs lg:h-80"
            itemContent={(_index, line) => (
              <div className="px-3 py-1.5 text-zinc-400">
                <span className="mr-2 text-zinc-600">{formatDuration(run.lastTs - run.startTs)}</span>{line.text}
              </div>
            )}
            followOutput={(atBottom) => atBottom ? 'auto' : false}
            atBottomStateChange={setIsAtBottom}
            atBottomThreshold={48}
          />
          <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500"><Check className="h-3 w-3" /> {labels.autoScroll}</div>
          {!isAtBottom && run.logs.length > 0 && (
            <button /* ds-allow:button: 虚拟日志回底悬浮按钮，IconButton 无绝对居中定位语义 */
              type="button"
              aria-label={labels.jumpToBottom}
              onClick={() => virtuosoRef.current?.scrollToIndex({ index: run.logs.length - 1, align: 'end' })}
              className="absolute bottom-10 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 shadow-lg"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

const CaseStatusIcon: React.FC<{ status: CasePresentationStatus }> = ({ status }) => {
  if (status === 'passed') return <Check className="h-3.5 w-3.5 text-[var(--cc-success)]" />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-[var(--cc-error)]" />;
  if (status === 'running') return <span className="w-3.5 animate-pulse font-mono text-[var(--cc-brand)]">⠋</span>;
  if (status === 'excluded') return <Minus className="h-3.5 w-3.5 text-[var(--cc-muted)]" />;
  return <Circle className="h-3.5 w-3.5 text-[var(--cc-gutter)]" />;
};
