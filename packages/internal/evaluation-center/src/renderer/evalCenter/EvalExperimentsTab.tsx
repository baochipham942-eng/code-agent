import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Beaker, RefreshCw } from 'lucide-react';
import type { EvalExperimentDetail, EvalExperimentListItem, EvalRunEvent, EvalRunPanelProbe, EvalRunRequest } from '@shared/contract/evaluation';
import { EVALUATION_CHANNELS } from '../../shared/evaluationChannels';
import { Badge } from '@renderer/components/primitives/Badge';
import { Button } from '@renderer/components/primitives/Button';
import { EmptyState } from '@renderer/components/primitives/EmptyState';
import { invokeEvaluation, onEvaluation } from '../evaluationRunIpc';
import { useEvaluationI18n } from '../i18n/useEvaluationI18n';
import { EvalExperimentResult } from './EvalExperimentResult';
import { EvalExperimentWizard } from './EvalExperimentWizard';
import { EvalRunProgress, reduceEvalActiveRun, type EvalActiveRun } from './EvalRunProgress';
import { getExperimentCompareConfig, getExperimentCompareSummary, getExperimentCost, stateClasses } from './evalExperimentPresentation';

function replace(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? '—' : `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

export const EvalExperimentsTab: React.FC = () => {
  const { t, language } = useEvaluationI18n();
  const labels = t.evalCenter.experiments;
  const runLabels = t.evalCenter.runPanel;
  const [experiments, setExperiments] = useState<EvalExperimentListItem[]>([]);
  const [probe, setProbe] = useState<EvalRunPanelProbe | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [activeRun, setActiveRun] = useState<EvalActiveRun | null>(null);
  const [selected, setSelected] = useState<EvalExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, panel] = await Promise.all([
        invokeEvaluation(EVALUATION_CHANNELS.LIST_EXPERIMENTS, { limit: 100, source: 'compare' }),
        invokeEvaluation(EVALUATION_CHANNELS.RUN_EVENTS),
      ]);
      setExperiments(list ?? []);
      if (panel && 'environment' in panel) setProbe(panel);
      setNotice(null);
    } catch {
      setNotice(labels.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [labels.loadFailed]);
  useEffect(() => {
    void load();
    return () => unsubscribeRef.current?.();
  }, [load]);

  const consumeEvent = useCallback((event: EvalRunEvent) => {
    if (event.schemaVersion !== 3 || event.type === 'error') {
      setNotice(event.type === 'error' ? event.error : runLabels.quietDegraded);
      setActiveRun(null);
      unsubscribeRef.current?.();
      void load();
      return;
    }
    if (event.type === 'run_end') {
      setNotice(event.error ?? (event.aborted ? runLabels.incomplete : null));
      setActiveRun(null);
      unsubscribeRef.current?.();
      void load();
      return;
    }
    setActiveRun((current) => current?.runId === event.runId
      ? reduceEvalActiveRun(current, event, runLabels)
      : current);
  }, [load, runLabels]);

  const start = useCallback(async (request: EvalRunRequest) => {
    setStarting(true); setNotice(null);
    try {
      const result = await invokeEvaluation(EVALUATION_CHANNELS.RUN_SUITE, request);
      setWarnings(result.warnings ?? []);
      const now = Date.now();
      setActiveRun({
        runId: result.runId,
        split: request.split === 'held-out' || request.split === 'safety' ? request.split : 'held-in',
        model: probe?.model ?? 'unknown',
        provider: probe?.provider ?? 'unknown',
        plannedCaseIds: [], cases: {}, startTs: now, lastTs: now,
        logs: [], toolCounts: {}, stopping: false,
      });
      setWizardOpen(false);
      unsubscribeRef.current?.();
      const unsubscribe = onEvaluation(EVALUATION_CHANNELS.RUN_EVENTS, (event: EvalRunEvent) => {
        if (event.runId !== result.runId) return;
        consumeEvent(event);
      });
      unsubscribeRef.current = unsubscribe;
      if (!unsubscribe) throw new Error(runLabels.quietDegraded);
      const subscription = await invokeEvaluation(EVALUATION_CHANNELS.RUN_EVENTS, { runId: result.runId });
      if (!('running' in subscription) || !subscription.running) {
        setNotice(runLabels.endedBeforeSubscribe);
        setActiveRun(null);
        unsubscribe();
        void load();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : labels.runFailed);
    } finally {
      setStarting(false);
    }
  }, [consumeEvent, labels.runFailed, load, probe, runLabels]);

  const stop = useCallback(async () => {
    if (!activeRun || activeRun.stopping) return;
    setActiveRun((current) => current ? { ...current, stopping: true } : current);
    try {
      await invokeEvaluation(EVALUATION_CHANNELS.ABORT_RUN, { runId: activeRun.runId });
    } catch {
      setNotice(runLabels.quietDegraded);
      setActiveRun(null);
      void load();
    }
  }, [activeRun, load, runLabels.quietDegraded]);

  const openResult = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const detail = await invokeEvaluation(EVALUATION_CHANNELS.LOAD_EXPERIMENT, id);
      if (!detail) throw new Error(labels.loadFailed);
      setSelected(detail);
    } catch {
      setNotice(labels.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [labels.loadFailed]);

  if (selected) return <EvalExperimentResult detail={selected} onBack={() => setSelected(null)} />;
  return <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 p-4" data-testid="eval-experiments-tab">
    <div className="flex items-center gap-2">
      <h2 className="text-sm font-semibold text-zinc-200">{labels.title}</h2>
      <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="refresh"><RefreshCw className="h-3.5 w-3.5" /></Button>
      <Button className="ml-auto" size="sm" onClick={() => { setWarnings([]); setWizardOpen(true); }}>{labels.create}</Button>
    </div>
    {notice && <div className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400" role="status">{notice}</div>}
    {activeRun && <div className="mt-3"><EvalRunProgress run={activeRun} labels={runLabels} onStop={() => void stop()} /></div>}
    {!loading && experiments.length === 0 ? <div className="mt-4"><EmptyState variant="panel" icon={Beaker} title={labels.emptyTitle} text={<><span>{labels.emptyBody}</span><span className="mt-3 block"><Button size="sm" onClick={() => setWizardOpen(true)}>{labels.create}</Button></span></>} /></div> : null}
    <div className="mt-4 space-y-2">
      {experiments.map((experiment, index) => {
        const compare = getExperimentCompareSummary(experiment);
        const config = getExperimentCompareConfig(experiment);
        const verdict = compare?.shipGate;
        const noPairs = experiment.summary?.completed === false || Boolean(experiment.summary?.error);
        const currentSha = typeof experiment.config?.caseBankSha === 'string' ? experiment.config.caseBankSha : null;
        const previousSha = typeof experiments[index + 1]?.config?.caseBankSha === 'string'
          ? experiments[index + 1].config?.caseBankSha as string
          : null;
        return <button type="button" key={experiment.id} onClick={() => void openResult(experiment.id)} className="w-full rounded-lg bg-zinc-900 p-3 text-left hover:bg-zinc-800" data-testid={`experiment-row-${experiment.id}`}>
          <div className="grid items-center gap-3 md:grid-cols-[minmax(9rem,1fr)_minmax(14rem,2fr)_minmax(12rem,1fr)_auto_auto]">
            <div className="text-sm font-medium text-zinc-200">{experiment.name}</div>
            <div className="truncate text-xs text-zinc-400"><span className="text-zinc-500">{labels.diff}：</span>{config?.diff.join(' · ') || labels.same}</div>
            <div>{noPairs || !verdict ? <Badge className="border-zinc-700 bg-zinc-800 text-zinc-300">{labels.noPairs}</Badge> : <>
              <Badge className={stateClasses(verdict.state)}>{labels.states[verdict.state]}{verdict.state === 'non_inferior' ? ` · Δ ${verdict.delta}pp` : ''}</Badge>
              {!verdict.hardGate.passed && <Badge className="ml-1 border-badge-danger bg-badge-danger text-badge-danger">{labels.hardGateFailed}</Badge>}
              {verdict.state === 'insufficient' && <div className="mt-1 text-[10px] text-zinc-500">{labels.insufficientHint}</div>}
              <div className="mt-1 text-[10px] text-zinc-500">{replace(labels.winsLine, { n: verdict.decisivePairs, candidate: compare.candidateWins, baseline: compare.baselineWins })}</div>
            </>}</div>
            <div className="text-xs text-zinc-500">{new Date(experiment.timestamp).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}</div>
            <div className="text-xs text-zinc-500">{formatUsd(getExperimentCost(experiment))}</div>
          </div>
          {currentSha && previousSha && currentSha !== previousSha && <div className="mt-1 text-[10px] text-badge-warning">{labels.refreshedBank}</div>}
        </button>;
      })}
    </div>
    {probe && <EvalExperimentWizard open={wizardOpen} probe={probe} starting={starting} warnings={warnings} onClose={() => setWizardOpen(false)} onStart={start} />}
  </div>;
};
